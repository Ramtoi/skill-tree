import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Button } from "@/components/Button";

describe("ScreenHeader", () => {
	it("orders slots: back/leading → title block → state → primary → overflow", () => {
		const { container } = render(
			<ScreenHeader
				leading={<span className="project-dot" data-testid="dot" />}
				title="Library"
				state={<StatePill state="unsaved">UNSAVED</StatePill>}
				primary={
					<Button variant="primary" data-testid="primary">
						New skill
					</Button>
				}
				overflow={[{ icon: "refresh", label: "Sync", onClick: () => {} }]}
			/>,
		);
		const header = container.querySelector(".main-header")!;
		expect(header).toBeTruthy();
		// leading precedes the title block
		const leading = header.querySelector(".header-leading");
		const title = header.querySelector(".main-title");
		expect(leading).toBeTruthy();
		expect(
			leading!.compareDocumentPosition(title!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// state pill lives inside the title block
		expect(title!.querySelector(".state-pill")).toBeTruthy();
		// primary + overflow sit in the right cluster, primary before kebab
		const right = header.querySelector(".main-header-right")!;
		expect(right.querySelector('[data-testid="primary"]')).toBeTruthy();
		expect(
			right.querySelector('[aria-label="More actions"]'),
		).toBeTruthy();
	});

	it("renders no subheader row when the prop is omitted", () => {
		const { container } = render(<ScreenHeader title="Library" />);
		expect(container.querySelector(".main-subheader")).toBeNull();
	});

	it("renders the subheader row (left/right) when supplied", () => {
		const { container } = render(
			<ScreenHeader
				title="Library"
				subheader={{ left: <span>L</span>, right: <span>R</span> }}
			/>,
		);
		expect(container.querySelector(".main-subheader")).toBeTruthy();
		expect(container.querySelector(".main-subheader-left")).toBeTruthy();
		expect(container.querySelector(".main-subheader-right")).toBeTruthy();
	});

	it("omits the right cluster when subheader.right is falsy", () => {
		const { container } = render(
			<ScreenHeader title="Library" subheader={{ left: <span>L</span> }} />,
		);
		expect(container.querySelector(".main-subheader-left")).toBeTruthy();
		expect(container.querySelector(".main-subheader-right")).toBeNull();
	});

	it("renders back over leading when both are supplied", () => {
		const onBack = vi.fn();
		const { container } = render(
			<ScreenHeader
				back={{ label: "Library", onClick: onBack }}
				leading={<span className="project-dot" />}
				title="Detail"
			/>,
		);
		expect(container.querySelector(".header-back")).toBeTruthy();
		expect(container.querySelector(".header-leading")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Library" }));
		expect(onBack).toHaveBeenCalled();
	});

	it("composes crumbs and subline on a single line with a separator", () => {
		const { container } = render(
			<ScreenHeader
				title="Project"
				crumbs={["a", "b"]}
				subline="last sync —"
			/>,
		);
		const crumbs = container.querySelector(".crumbs")!;
		expect(crumbs.textContent).toContain("a");
		expect(crumbs.textContent).toContain("b");
		expect(crumbs.textContent).toContain("last sync —");
		// the subline separator is the middle-dot
		expect(crumbs.textContent).toContain("·");
	});

	it("renders subline alone in crumbs when no crumbs are given", () => {
		const { container } = render(
			<ScreenHeader title="Project" subline="solo line" />,
		);
		const crumbs = container.querySelector(".crumbs")!;
		expect(crumbs).toBeTruthy();
		expect(crumbs.textContent).toContain("solo line");
	});

	it("renders back arrow, bundle glyph, and mono name together (bundle case)", () => {
		const { container } = render(
			<ScreenHeader
				back={{ label: "Library", onClick: () => {} }}
				title={
					<span className="bundle-glyph header-bundle-glyph">📦</span>
				}
				nameMono="android"
			/>,
		);
		const header = container.querySelector(".main-header")!;
		expect(header.querySelector(".header-back")).toBeTruthy();
		expect(header.querySelector(".bundle-glyph")).toBeTruthy();
		expect(header.querySelector(".title-mono")?.textContent).toBe("android");
	});
});
