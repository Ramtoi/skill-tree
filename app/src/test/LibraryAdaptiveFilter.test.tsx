import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, sampleRegistry, makeQueryClient, mockCommands } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import type { Registry } from "@/types";

// `userEvent`'s inter-keystroke/click awaits give react-query's `staleTime: 0`
// background refetch time to land — an unmocked `read_registry` resolving to
// `undefined` (setup.ts's default) would clobber the primed data mid-test, so
// every command the Library reads on mount is mocked explicitly (mirrors
// `SkillLibrarySearch.test.tsx`'s `mockInvoke`).
function mockInvoke(registry: Registry) {
	mockCommands({
		read_registry: registry,
		snippets_list: [],
		local_skill_candidates: [],
		harness_list: [],
		hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
		read_search_corpus: { skills: {}, snippets: {} },
	});
}

/** Installs live-mutable `clientWidth` (row) / `offsetWidth` (right cluster) /
 *  `scrollWidth` (facets content) getters on `HTMLElement.prototype` —
 *  `useFitsInline` reads `row.clientWidth`, `right.offsetWidth`, and
 *  `content.scrollWidth` (see its doc comment for why the ROW and the right
 *  cluster, not `.main-subheader-left` itself). `clientWidth`/`scrollWidth`
 *  are own properties of `Element.prototype` in jsdom (never
 *  `HTMLElement.prototype`), so there is no original descriptor to restore —
 *  `restore()` `delete`s those two, or they would permanently shadow
 *  `Element.prototype`'s getter for every later test in the file.
 *  `offsetWidth` IS a real `HTMLElement.prototype` own property in jsdom, so
 *  its original descriptor is saved and restored properly. `setWidths`
 *  mutates the closed-over values without redefining the properties, so a
 *  later `ResizeObserver` callback re-reads the new numbers. */
function installControllableWidths(
	initialClient: number,
	initialScroll: number,
	initialOffset: number,
) {
	let client = initialClient;
	let scroll = initialScroll;
	let offset = initialOffset;
	const offsetWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => client,
	});
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get: () => scroll,
	});
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get: () => offset,
	});
	return {
		setWidths(newClient: number, newScroll: number, newOffset: number) {
			client = newClient;
			scroll = newScroll;
			offset = newOffset;
		},
		restore() {
			delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
			delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
			if (offsetWidthDesc) {
				Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDesc);
			} else {
				delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
			}
		},
	};
}

/** Forces `useFitsInline` to the collapsed path for the lifetime of the test:
 *  row.clientWidth(300) − right.offsetWidth(80) − the 10px gap fallback
 *  leaves ~210px of available width, well under the facets' stubbed natural
 *  width (900) — collapsed regardless of which pair of elements the hook
 *  happens to measure. */
function stubNarrow(): () => void {
	const { restore } = installControllableWidths(300, 900, 80);
	return restore;
}

/** A `ResizeObserver` stub that records every constructed instance so a test
 *  can invoke its callback on demand — jsdom's own stub (installed globally
 *  in setup.ts) is a no-op, so `useFitsInline`'s live remeasurement can only
 *  be exercised by taking over the constructor for the duration of one test. */
class ControllableResizeObserver {
	static instances: ControllableResizeObserver[] = [];
	private cb: ResizeObserverCallback;
	constructor(cb: ResizeObserverCallback) {
		this.cb = cb;
		ControllableResizeObserver.instances.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
	trigger() {
		// `useFitsInline`'s callback (`measure`) ignores its arguments and
		// re-reads `clientWidth`/`scrollWidth` directly, so the entries/observer
		// arguments below are never inspected.
		this.cb([], this as unknown as ResizeObserver);
	}
}

/** `sampleRegistry` with the given skills' `invocation` mirror overridden. */
function withInvocation(
	overrides: Record<string, Registry["skills"][string]["invocation"]>,
): Registry {
	const skills = { ...sampleRegistry.skills };
	for (const [name, invocation] of Object.entries(overrides)) {
		skills[name] = { ...skills[name], invocation };
	}
	return { ...sampleRegistry, skills };
}

async function renderLibrary(registry: Registry = sampleRegistry) {
	mockInvoke(registry);
	const utils = renderWithProviders(<SkillLibrary />, { client: makeQueryClient() });
	await screen.findByTestId("floating-search-input");
	return utils;
}

/** Picks a SOURCE option from the `Select` — scoped to `root` (`document`
 *  when omitted) so the same helper drives both the inline row and the
 *  stacked Filter popover. */
async function pickSource(name: string | RegExp, root: HTMLElement = document.body) {
	await userEvent.click(within(root).getByRole("combobox", { name: "Source" }));
	await userEvent.click(within(root).getByRole("option", { name }));
}

describe("Library adaptive filter row", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("1. wide (default): SOURCE Select + TRIGGER chips are inline, no Filter chip, no parked twin", async () => {
		await renderLibrary();

		expect(screen.getByRole("combobox", { name: "Source" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "User-only" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();
		expect(document.querySelector(".library-facets[data-collapsed]")).toBeNull();
	});

	describe("narrow", () => {
		let restore: () => void;
		beforeEach(() => {
			restore = stubNarrow();
		});
		afterEach(() => {
			restore();
		});

		it("2. collapses to a Filter chip; the inline facets (incl. the SOURCE Select) are parked out of accessibility reach", async () => {
			await renderLibrary();

			const twin = document.querySelector(".library-facets[data-collapsed]");
			expect(twin).not.toBeNull();
			const subheader = document.querySelector(".main-subheader") as HTMLElement;
			expect(within(subheader).queryByRole("combobox", { name: "Source" })).toBeNull();
			expect(within(subheader).getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
		});

		it("clicking Filter opens a dialog with the SOURCE Select and TRIGGER group; picking a source narrows the list and shows the summary chip + Filter 1", async () => {
			await renderLibrary();

			const filterBtn = screen.getByRole("button", { name: /^Filter/ });
			await userEvent.click(filterBtn);

			const dialog = screen.getByRole("dialog", { name: "Filter skills" });
			expect(within(dialog).getByText("SOURCE")).toBeInTheDocument();
			expect(within(dialog).getByText("TRIGGER")).toBeInTheDocument();
			expect(within(dialog).getByRole("combobox", { name: "Source" })).toBeInTheDocument();

			// The option lives inside the popover's own DOM subtree (the `Select`
			// isn't portalled) — picking it must not read as an "outside" click
			// and close the Popover before the pick lands.
			await pickSource(/Org Skills/, dialog);

			expect(screen.getByRole("dialog", { name: "Filter skills" })).toBeInTheDocument();
			// The list narrowed…
			expect(screen.queryByText("brainstorm")).toBeNull();
			expect(screen.getByText("android-compose-ui")).toBeInTheDocument();
			// …the removable summary chip appeared…
			expect(screen.getByTitle("Clear source filter")).toBeInTheDocument();
			// …and the Filter chip carries the active count.
			expect(
				within(screen.getByRole("button", { name: /^Filter/ })).getByText("1"),
			).toBeInTheDocument();
		});

		it("Escape closes the popover and returns focus to the Filter chip", async () => {
			await renderLibrary();
			const filterBtn = screen.getByRole("button", { name: /^Filter/ });

			vi.useFakeTimers();
			try {
				fireEvent.click(filterBtn);
				act(() => {
					vi.runAllTimers(); // flush the popover's focus-into-panel rAF
				});

				const dialog = screen.getByRole("dialog", { name: "Filter skills" });
				// A version of this test that presses Escape without first proving
				// focus actually moved INTO the panel would pass even with the
				// restore-focus code deleted — assert the starting state for real.
				expect(dialog.contains(document.activeElement)).toBe(true);

				fireEvent.keyDown(dialog, { key: "Escape" });
				act(() => {
					vi.runAllTimers(); // flush the restore-focus rAF
				});

				expect(screen.queryByRole("dialog", { name: "Filter skills" })).toBeNull();
				expect(filterBtn).toHaveFocus();
			} finally {
				vi.useRealTimers();
			}
		});

		it("clicking outside the popover closes it", async () => {
			await renderLibrary();
			await userEvent.click(screen.getByRole("button", { name: /^Filter/ }));
			expect(screen.getByRole("dialog", { name: "Filter skills" })).toBeInTheDocument();

			fireEvent.mouseDown(document.body);

			expect(screen.queryByRole("dialog", { name: "Filter skills" })).toBeNull();
		});
	});

	describe("trigger facet", () => {
		it("3a. picking User-only narrows to user-only skills, and clicking it again resets to all", async () => {
			await renderLibrary(withInvocation({ "rt-android-expert": "user-only" }));

			expect(screen.getByText("brainstorm")).toBeInTheDocument();
			expect(screen.getByText("rt-android-expert")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "User-only" }));
			expect(screen.queryByText("brainstorm")).toBeNull();
			expect(screen.getByText("rt-android-expert")).toBeInTheDocument();

			await userEvent.click(screen.getByRole("button", { name: "User-only" }));
			expect(screen.getByText("brainstorm")).toBeInTheDocument();
			expect(screen.getByText("rt-android-expert")).toBeInTheDocument();
		});

		it("3b. Conflicted is absent when no skill is conflicted", async () => {
			await renderLibrary();
			expect(screen.queryByRole("button", { name: "Conflicted" })).toBeNull();
		});

		it("3c. Conflicted is present and narrows the list when a skill is conflicted", async () => {
			await renderLibrary(withInvocation({ "rt-android-expert": "conflicted" }));

			const conflictedChip = screen.getByRole("button", { name: "Conflicted" });
			expect(conflictedChip).toBeInTheDocument();

			await userEvent.click(conflictedChip);
			expect(screen.queryByText("brainstorm")).toBeNull();
			expect(screen.getByText("rt-android-expert")).toBeInTheDocument();
		});

		it("3d. Conflicted stays visible and pressed after the registry no longer has a conflicted skill, and clicking it still clears the filter", async () => {
			const { client } = await renderLibrary(
				withInvocation({ "rt-android-expert": "conflicted" }),
			);

			await userEvent.click(screen.getByRole("button", { name: "Conflicted" }));
			expect(screen.queryByText("brainstorm")).toBeNull();

			// The registry re-syncs — the skill that WAS conflicted got fixed — but
			// the ACTIVE filter must not silently vanish out from under the user
			// with no lit chip left to clear it.
			mockInvoke(sampleRegistry);
			client.setQueryData(["registry"], sampleRegistry);

			const stillThere = await screen.findByRole("button", { name: "Conflicted" });
			expect(stillThere).toHaveAttribute("aria-pressed", "true");

			await userEvent.click(stillThere);
			expect(screen.getByText("brainstorm")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Conflicted" })).toBeNull();
		});
	});

	it("4. unified search + a source facet: the SKILLS kind-chip count equals the visible rows", async () => {
		await renderLibrary();

		await userEvent.type(screen.getByTestId("floating-search-input"), "android");
		await pickSource(/Org Skills/);

		const listSkillRows = document.querySelectorAll(".lib-list .skill-row");
		expect(listSkillRows.length).toBe(1); // android-compose-ui only (org-skills)

		const skillsChip = within(screen.getByTestId("floating-search-kinds")).getByRole("button", {
			name: /^SKILLS/,
		});
		expect(within(skillsChip).getByText(String(listSkillRows.length))).toBeInTheDocument();
	});

	describe("useFitsInline attaches on a later mount, not just the first render", () => {
		it("the row's fit measurement attaches once the subheader mounts for the first time (registry starts empty, then gains a skill)", async () => {
			const restore = stubNarrow();
			try {
				// An empty registry renders NO subheader at all (`registryEmpty`) —
				// `rowRef`/`rightRef`/`contentRef` never fire, so a `useRef`-based
				// hook's effect would have already run once against `null`s and
				// never re-run once the real nodes mount later on the SAME
				// component instance (a `useRef` object's identity never changes,
				// so it can never appear as a "new" effect dependency).
				const empty: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
				mockInvoke(empty);
				const { client } = renderWithProviders(<SkillLibrary />, {
					client: makeQueryClient(),
				});
				await screen.findByText("Create your first skill");
				expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();

				mockInvoke(sampleRegistry);
				client.setQueryData(["registry"], sampleRegistry);

				// The subheader (and the facets it measures) exists for the first
				// time only now — the Filter chip appearing proves the callback
				// refs attached and `useFitsInline` actually measured (stubbed
				// narrow) rather than silently staying at its `fits: true` default
				// forever.
				expect(await screen.findByRole("button", { name: /^Filter/ })).toBeInTheDocument();
			} finally {
				restore();
			}
		});
	});

	describe("useFitsInline live remeasurement", () => {
		let widths: {
			setWidths: (c: number, s: number, o: number) => void;
			restore: () => void;
		};
		let realRO: typeof ResizeObserver;

		beforeEach(() => {
			widths = installControllableWidths(300, 900, 80); // narrow at mount
			realRO = globalThis.ResizeObserver;
			ControllableResizeObserver.instances = [];
			globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;
		});
		afterEach(() => {
			globalThis.ResizeObserver = realRO;
			widths.restore();
		});

		it("starts collapsed, then flips back to inline once the row gains room and the observer fires", async () => {
			await renderLibrary();

			// Collapsed at mount: the parked twin exists and carries
			// `data-collapsed`, the Filter chip stands in for it.
			const twin = document.querySelector(".library-facets");
			expect(twin).not.toBeNull();
			expect(twin!.getAttribute("data-collapsed")).toBe("");
			expect(screen.getByRole("button", { name: /^Filter/ })).toBeInTheDocument();
			expect(ControllableResizeObserver.instances.length).toBeGreaterThan(0);

			// The row gains room (e.g. a wider window) — nothing re-renders on its
			// own in jsdom, so the observer callback is what `useFitsInline`
			// relies on to re-measure. Row 2000, right cluster a modest 200, well
			// under the facets' natural width (300) once the gap is subtracted too.
			widths.setWidths(2000, 300, 200);
			act(() => {
				for (const inst of ControllableResizeObserver.instances) inst.trigger();
			});

			expect(document.querySelector(".library-facets[data-collapsed]")).toBeNull();
			expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();
			expect(screen.getByRole("combobox", { name: "Source" })).toBeInTheDocument();
		});
	});
});
