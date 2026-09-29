import { describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { MD_FIXTURES } from "@/lib/renderMarkdown.fixtures";

function renderMd(md: string, onOpenLink?: (href: string) => void) {
	const { container } = render(<>{renderMarkdown(md, { onOpenLink })}</>);
	const root = container.querySelector(".md-prose") as HTMLElement;
	return root;
}

describe("renderMarkdown — golden fixtures", () => {
	for (const fx of MD_FIXTURES) {
		it(`renders ${fx.name}`, () => {
			const root = renderMd(fx.md);
			expect(root).toBeTruthy();
			// The fixture throws on any structural mismatch.
			fx.check(root);
			cleanup();
		});
	}
});

describe("renderMarkdown — link activation", () => {
	it("opens an http link through onOpenLink and prevents navigation", () => {
		const onOpenLink = vi.fn();
		const root = renderMd("[go](https://example.com)", onOpenLink);
		const a = root.querySelector("a.md-link") as HTMLAnchorElement;
		expect(a).toBeTruthy();
		const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
		a.dispatchEvent(evt);
		expect(onOpenLink).toHaveBeenCalledWith("https://example.com");
		expect(evt.defaultPrevented).toBe(true);
		cleanup();
	});

	it("does not open a non-web scheme", () => {
		const onOpenLink = vi.fn();
		const root = renderMd("[x](javascript:alert(1))", onOpenLink);
		expect(root.querySelector("a")).toBeNull();
		expect(onOpenLink).not.toHaveBeenCalled();
		cleanup();
	});
});
