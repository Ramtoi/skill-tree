import { useLayoutEffect, type RefObject } from "react";

/**
 * Sizes a textarea to its content on every value change and on every width
 * change, so a field that wraps grows instead of scrolling inside a fixed
 * box. The cap is the stylesheet's job (`max-height` + `overflow-y: auto`):
 * the hook only ever writes the content height, and the CSS clamp turns the
 * overflow into a scroll once the text passes the cap.
 */
function fit(el: HTMLTextAreaElement) {
	// Collapse first so a shorter value can shrink the box back.
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}

export function useAutoGrow(
	ref: RefObject<HTMLTextAreaElement | null>,
	value: string,
) {
	useLayoutEffect(() => {
		const el = ref.current;
		if (el) fit(el);
	}, [ref, value]);

	// The side panel is a resizable split: a narrower column re-wraps the
	// same text onto more lines. Observe the PARENT's width — observing the
	// textarea itself while writing its height is the resize-observer
	// feedback shape that Chromium reports as a window error.
	useLayoutEffect(() => {
		const el = ref.current;
		const parent = el?.parentElement;
		if (!el || !parent || typeof ResizeObserver === "undefined") return;
		let width = parent.getBoundingClientRect().width;
		const ro = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width ?? width;
			if (next === width) return;
			width = next;
			fit(el);
		});
		ro.observe(parent);
		return () => ro.disconnect();
	}, [ref]);
}
