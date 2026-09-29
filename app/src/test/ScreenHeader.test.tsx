import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Button } from "@/components/Button";

describe("ScreenHeader", () => {
	it("renders outside a router without throwing, and without an automatic back arrow", () => {
		// No `back` prop and no `<Router>` ancestor: `useInRouterContext()` must
		// steer this to the router-free branch rather than reaching `useLocation`
		// (which throws outside a Router). Every other test in this file already
		// renders bare — this one names the contract explicitly.
		expect(() => render(<ScreenHeader title="Library" />)).not.toThrow();
		expect(screen.queryByRole("button", { name: /^Back to / })).toBeNull();
	});

	it("orders slots: back/leading → title block → status → overflow → primary", () => {
		const { container } = render(
			<ScreenHeader
				leading={<span className="project-dot" data-testid="dot" />}
				title="Library"
				meta={<span data-testid="meta-chip" />}
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
		// the identity column precedes the title block, and the leading node
		// renders INTO it
		const identity = header.querySelector(".header-identity");
		const title = header.querySelector(".main-title");
		expect(identity).toBeTruthy();
		expect(identity!.querySelector(".header-leading .project-dot")).toBeTruthy();
		expect(
			identity!.compareDocumentPosition(title!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// meta + state live in the status cluster, NOT inside the h2 — inside the
		// 24px title line they float ~9px above the buttons they read as a row
		// with, because the row centres the 42px title BLOCK.
		const status = header.querySelector(".header-status")!;
		expect(status).toBeTruthy();
		expect(status.parentElement).toBe(header);
		expect(status.querySelector(".title-meta [data-testid='meta-chip']")).toBeTruthy();
		expect(status.querySelector(".title-state .state-pill")).toBeTruthy();
		const h2 = title!.querySelector("h2")!;
		expect(h2.querySelector(".title-meta")).toBeNull();
		expect(h2.querySelector(".title-state")).toBeNull();
		expect(title!.querySelector(".state-pill")).toBeNull();
		// primary + overflow sit in the right cluster, primary after kebab
		const right = header.querySelector(".main-header-right")!;
		expect(right.querySelector('[data-testid="primary"]')).toBeTruthy();
		expect(
			right.querySelector('[aria-label="More actions"]'),
		).toBeTruthy();
		// …and the status cluster sits BETWEEN the title block and the actions.
		expect(
			title!.compareDocumentPosition(status) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			status.compareDocumentPosition(right) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it.each([false, true])("keeps primary last with overflow present=%s", (withOverflow) => {
		const { container } = render(
			<ScreenHeader
				title="Library"
				primary={<><Button variant="soft">Import</Button><Button variant="primary">New skill</Button></>}
				secondary={<Button variant="ghost">Open project</Button>}
				overflow={withOverflow ? [{ label: "Sync", onClick: () => {} }] : undefined}
			/>,
		);
		const buttons = Array.from(container.querySelectorAll(".main-header-right button"));
		expect(buttons.map((button) => button.getAttribute("aria-label") || button.textContent)).toEqual(
			[...(withOverflow ? ["More actions"] : []), "Open project", "Import", "New skill"],
		);
	});

	it("omits the status wrapper entirely when neither meta nor state is set", () => {
		// An empty cluster would still eat one 12px row gap.
		const { container } = render(<ScreenHeader title="Library" />);
		expect(container.querySelector(".header-status")).toBeNull();
	});

	it("always reserves the 40px identity column, even with no identity prop", () => {
		const { container } = render(<ScreenHeader title="Library" />);
		const identity = container.querySelector(".main-header > .header-identity");
		expect(identity).toBeTruthy();
		// an empty spacer: present in the DOM, holding nothing
		expect(identity!.childElementCount).toBe(0);
	});

	it("always reserves the secondary crumb line, even with no crumbs or subline", () => {
		const { container } = render(<ScreenHeader title="Library" />);
		const crumbs = container.querySelector(".main-title .crumbs");
		expect(crumbs).toBeTruthy();
		expect(crumbs!.textContent).toBe("");
	});

	it("renders back icon-only, labelled for assistive tech and hover", () => {
		const { container } = render(
			<ScreenHeader back={{ label: "Library", onClick: () => {} }} title="X" />,
		);
		const back = container.querySelector(".header-back")!;
		expect(back).toBeTruthy();
		// no visible label at any width — the parent is named by title/crumbs
		expect(back.querySelector(".btn-label")).toBeNull();
		expect(back).not.toHaveAttribute("title");
		expect(back.getAttribute("aria-label")).toBe("Back to Library");
		// and it lives in the shared identity column
		expect(
			container.querySelector(".header-identity .header-back"),
		).toBeTruthy();
	});

	it("icon slot renders the standardized section chip with a lit live point", () => {
		const { container } = render(<ScreenHeader icon="harness" title="Harnesses" />);
		const chip = container.querySelector(".header-leading .header-glyph");
		expect(chip).toBeTruthy();
		// The chip is a live-glint host pinned to the selected state — the
		// header is the "you are here" surface.
		expect(chip!.classList.contains("live-glint")).toBe(true);
		expect(chip!.getAttribute("data-live")).toBe("true");
		expect(chip!.querySelector("svg .ic-live")).toBeTruthy();
	});

	it("slot precedence: back beats leading beats icon", () => {
		const both = render(
			<ScreenHeader
				leading={<span data-testid="custom-identity" />}
				icon="harness"
				title="X"
			/>,
		);
		expect(both.container.querySelector('[data-testid="custom-identity"]')).toBeTruthy();
		expect(both.container.querySelector(".header-glyph")).toBeNull();
		both.unmount();

		const withBack = render(
			<ScreenHeader
				back={{ label: "Library", onClick: () => {} }}
				icon="harness"
				title="X"
			/>,
		);
		expect(withBack.container.querySelector(".header-back")).toBeTruthy();
		expect(withBack.container.querySelector(".header-glyph")).toBeNull();
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
		fireEvent.click(screen.getByRole("button", { name: "Back to Library" }));
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

	it("renders `secondary` in the action cluster beside `primary`, both present at once", () => {
		// design D14.5 — the Usage screen's transcript-scan action needs a
		// slot that survives every gate `overflow` would hide it behind, and
		// it must never collide with the one primary button.
		const { container } = render(
			<ScreenHeader
				title="Usage"
				primary={
					<Button variant="primary" data-testid="primary">
						Refresh scan
					</Button>
				}
				secondary={
					<Button variant="ghost" data-testid="secondary">
						Scan
					</Button>
				}
			/>,
		);
		const right = container.querySelector(".main-header-right")!;
		const primaryEl = right.querySelector('[data-testid="primary"]');
		const secondaryEl = right.querySelector('[data-testid="secondary"]');
		expect(primaryEl).toBeTruthy();
		expect(secondaryEl).toBeTruthy();
		// Secondary precedes primary in both reading and keyboard order.
		expect(
			secondaryEl!.compareDocumentPosition(primaryEl!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders `secondary` alone, with no primary present", () => {
		const { container } = render(
			<ScreenHeader
				title="Usage"
				secondary={
					<Button variant="ghost" data-testid="secondary">
						Scan
					</Button>
				}
			/>,
		);
		expect(
			container.querySelector('.main-header-right [data-testid="secondary"]'),
		).toBeTruthy();
	});

	it("renders a detail screen as back + mono name, with no glyph smuggled into the title", () => {
		// The bundle editor used to prefix its emoji chip to `title` because
		// `back` and `leading` could not coexist. The identity column is now
		// single-purpose, so that workaround is gone: the emoji lives in the
		// body hero where it has room to be an identity, not a 26px stowaway.
		const { container } = render(
			<ScreenHeader
				back={{ label: "Library", onClick: () => {} }}
				nameMono="android"
				crumbs={["library", "bundles"]}
			/>,
		);
		const header = container.querySelector(".main-header")!;
		expect(header.querySelector(".header-back")).toBeTruthy();
		expect(header.querySelector(".bundle-glyph")).toBeNull();
		expect(header.querySelector(".title-mono")?.textContent).toBe("android");
	});
});
