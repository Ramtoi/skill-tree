import { describe, it, expect } from "vitest";
import { screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { renderWithProviders, sampleRegistry, makeQueryClient, mockCommands, fail } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { ScreenHeader } from "@/components/ScreenHeader";
import { focusScreenSearch } from "@/lib/focusScreenSearch";
import type { SnippetInfo } from "@/types/snippets";
import type { Registry } from "@/types";

/** Renders the router state of whatever route the click landed on. `data-
 *  search`/`data-state` (wave 2) let a test inspect the referrer and the
 *  `libReturn` restore payload a Library-opened result carries — existing
 *  callers only read the text content (the pathname), so this is additive. */
function LocationProbe() {
  const loc = useLocation();
  return (
    <div
      data-testid="loc"
      data-search={loc.search}
      data-state={JSON.stringify(loc.state ?? null)}
    >
      {loc.pathname}
    </div>
  );
}

/** H10: a real `navigate(-1)` pop, not a remount with hand-built state — the
 *  destination a Library-opened skill route lands on in these tests. */
function GoBackProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back
    </button>
  );
}

// One inline snippet, not a shared multi-snippet corpus.
const SNIPPET_FIXTURE: SnippetInfo[] = [
  {
    name: "review-checklist",
    description: "Pre-merge review checklist.",
    tags: ["review"],
    version: 1,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    hash: "sha-review-checklist",
  },
];

/** Empty by default: most tests here exercise band A (name/description/tags)
 *  only, and never need a body to search. */
const EMPTY_CORPUS = { skills: {}, snippets: {} };

/** `read_registry`/`snippets_list` mocked explicitly (not just `setQueryData`
 *  priming): `makeQueryClient()`'s `staleTime: 0` fires an eager background
 *  refetch on mount, and `userEvent.type`'s inter-keystroke awaits give it
 *  time to land — an unmocked "read_registry" resolving to `undefined` would
 *  clobber the primed data mid-test. `corpus` behind `read_search_corpus` —
 *  pass `"reject"` to pin the degrade-to-band-A path (test F). */
function mockInvoke(
  registry: Registry,
  snippets: SnippetInfo[] = SNIPPET_FIXTURE,
  corpus: { skills: Record<string, string>; snippets: Record<string, string> } | "reject" = EMPTY_CORPUS,
) {
  mockCommands({
    read_registry: registry,
    snippets_list: snippets,
    local_skill_candidates: [],
    harness_list: [],
    hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
    read_search_corpus: corpus === "reject" ? fail("corpus unavailable") : corpus,
  });
}

/** Renders the Library and waits for a settled screen. `skills`/`bundles`/
 *  `snippets` empty all at once is the only case with no search surface at
 *  all (m12: the dock keys off `searchItems.length`, not the skill count
 *  alone, so it may show even when the top-level body still reads
 *  "Create your first skill"). */
async function renderLibrary(
  registry: Registry = sampleRegistry,
  snippets: SnippetInfo[] = SNIPPET_FIXTURE,
  corpus: { skills: Record<string, string>; snippets: Record<string, string> } | "reject" = EMPTY_CORPUS,
  // Wave 2: lets a test mount directly at a query-string/state combination
  // (e.g. a restored `libReturn`) instead of always landing on a fresh `/`.
  initialRoute: string | { pathname: string; search?: string; state?: unknown } = "/",
) {
  mockInvoke(registry, snippets, corpus);
  const utils = renderWithProviders(
    <Routes>
      <Route path="/" element={<SkillLibrary />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { client: makeQueryClient(), initialRoute },
  );
  const hasSearchable =
    Object.keys(registry.skills).length > 0 ||
    Object.keys(registry.bundles ?? {}).length > 0 ||
    snippets.length > 0;
  if (Object.keys(registry.skills).length > 0) {
    await screen.findByTestId("floating-search-input");
  } else if (hasSearchable) {
    await screen.findByTestId("floating-search");
  } else {
    await screen.findByText("Create your first skill");
  }
  return utils;
}

function kindsRow() {
  return screen.getByTestId("floating-search-kinds");
}

function sectionLabel(text: string) {
  return screen.getByText(text, { selector: ".section-label" });
}

/** Picks "Org Skills" in the SOURCE `Select` — inline in the subheader at the
 *  jsdom default width, no Filter popover involved. */
async function applySourceFacet() {
  await userEvent.click(screen.getByRole("combobox", { name: "Source" }));
  await userEvent.click(screen.getByRole("option", { name: /Org Skills/ }));
}

describe("SkillLibrary — unified floating search", () => {
  it("1. the subheader carries the SOURCE and TRIGGER groups, GROUP chips, and the view toggle, no Filter chip", async () => {
    await renderLibrary();
    const subheader = document.querySelector(".main-subheader") as HTMLElement;
    expect(subheader).not.toBeNull();
    expect(subheader.querySelector(".search-input")).toBeNull();
    expect(within(subheader).queryByRole("button", { name: /^ALL/ })).toBeNull();
    // Wide (jsdom default: `useFitsInline` measures both widths as 0, so it
    // fits) — the facets are inline, no Filter chip stands in for them.
    expect(within(subheader).queryByRole("button", { name: /^Filter/ })).toBeNull();
    expect(within(subheader).getByRole("combobox", { name: "Source" })).toBeInTheDocument();
    expect(within(subheader).getByRole("button", { name: "User-only" })).toBeInTheDocument();
    expect(within(subheader).getByTitle("Group by source")).toBeInTheDocument();
    expect(within(subheader).getByRole("button", { name: "List view" })).toBeInTheDocument();
    expect(within(subheader).getByRole("button", { name: "Grid view" })).toBeInTheDocument();
  });

  it("2. the floating bar exists and is the `/` screen search", async () => {
    const { container } = await renderLibrary();
    expect(screen.getByTestId("floating-search")).toBeInTheDocument();
    act(() => {
      expect(focusScreenSearch(container)).toBe(true);
    });
    expect(screen.getByTestId("floating-search-input")).toHaveFocus();
  });

  it("3. typing filters the list in place", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");
    // Wave 2: a matched skill-row name is marked (`nameNode`), so the text
    // is split across `<mark>`/`<span>` runs — match on the name span's
    // `title` (always the plain string) instead of an exact text node.
    expect(document.querySelector('.resource-name[title="rt-android-expert"]')).toBeInTheDocument();
    expect(document.querySelector('.resource-name[title="android-compose-ui"]')).toBeInTheDocument();
    expect(document.querySelector('.resource-name[title="brainstorm"]')).toBeNull();
  });

  it("4. a bundle match renders as a body row under a BUNDLES group (alongside the skill groups) and navigates on click", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");
    // The bar itself carries no results (§11) — no listbox, no hit rows on it.
    expect(screen.queryByTestId("floating-search-hits")).toBeNull();
    expect(sectionLabel("BUNDLES")).toBeInTheDocument();
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "bundle");
    expect(hit).toHaveAttribute("data-id", "android");
    fireEvent.click(hit);
    expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
  });

  it("5. a snippet match with zero matching skills renders alone under SNIPPETS, no empty state, and navigates on click", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "review");
    expect(screen.queryByText("No matching skills")).toBeNull();
    expect(sectionLabel("SNIPPETS")).toBeInTheDocument();
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "snippet");
    expect(hit).toHaveAttribute("data-id", "review-checklist");
    fireEvent.click(hit);
    expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/review-checklist");
  });

  it("6. skills never duplicate as body-hit rows", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");
    const hits = screen.getAllByTestId("library-body-hit");
    expect(hits.some((h) => h.dataset.kind === "skill")).toBe(false);
  });

  it("7a. selecting BUNDLES shows a BUNDLES section header and body hit rows; a row navigates", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));

    // M6: the same SectionHeader markup GLOBAL/PORTABLE use, kind + count.
    // Scoped to ".section-label" — the kind pill and the kind chip both also
    // render the literal text "BUNDLES" elsewhere on screen.
    const header = document.querySelector(".section-header") as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByText("BUNDLES", { selector: ".section-label" })).toBeInTheDocument();
    expect(within(header).getByText("1")).toBeInTheDocument();

    const bodyHit = screen.getByTestId("library-body-hit");
    expect(bodyHit).toHaveAttribute("data-kind", "bundle");
    expect(bodyHit).toHaveAttribute("data-id", "android");
    expect(screen.queryByTestId("floating-search-hits")).toBeNull();

    fireEvent.click(bodyHit);
    expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
  });

  it("7b-candidates. the Detected-local-skills banner hides while kind is bundle/snippet (M6)", async () => {
    const candidate = [
      {
        name: "hand-authored",
        project: "example-app",
        path: "/p/.claude/skills/hand-authored",
        category: "NEW" as const,
        description: "authored in-project",
      },
    ];
    mockCommands({
      read_registry: sampleRegistry,
      snippets_list: SNIPPET_FIXTURE,
      local_skill_candidates: candidate,
      harness_list: [],
      hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
      read_search_corpus: EMPTY_CORPUS,
    });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<SkillLibrary />} />
      </Routes>,
      { client: makeQueryClient() },
    );
    await screen.findByTestId("floating-search-input");
    await screen.findByText(/Detected/i);

    fireEvent.focus(screen.getByTestId("floating-search-input"));
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));
    expect(screen.queryByText(/Detected/i)).toBeNull();
  });

  it("7b. the kind pill survives a blur and restores the skill rows when clicked", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));
    fireEvent.blur(input);

    const pill = screen.getByTestId("floating-search-kind-pill");
    expect(pill).toHaveTextContent("BUNDLES");
    expect(screen.queryByTestId("library-body-hit")).not.toBeNull(); // still bundle mode

    fireEvent.click(pill);
    expect(screen.queryByTestId("floating-search-kind-pill")).toBeNull();
    expect(screen.queryByTestId("library-body-hit")).toBeNull();
    expect(screen.getByText("rt-android-expert")).toBeInTheDocument();
  });

  it("7c. no matching bundle/snippet gets kind-aware copy and a Show skills action that restores the list", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));
    await userEvent.type(input, "zzz-no-such-bundle");

    expect(screen.getByText("No matching bundles")).toBeInTheDocument();
    expect(screen.queryByText("No matching skills")).toBeNull();
    expect(screen.queryByTestId("library-body-hit")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show skills" }));
    // "Show skills" resets the KIND, not the query — the leftover
    // "zzz-no-such-bundle" text still filters the (now visible) skill list.
    expect(screen.queryByTestId("library-body-hit")).toBeNull();
    expect(screen.queryByText("No matching bundles")).toBeNull();
    await userEvent.clear(input);
    expect(screen.getByText("rt-android-expert")).toBeInTheDocument();
  });

  it("8. the N of M header tag hides for kind = bundle/snippet and returns for all", async () => {
    await renderLibrary();
    expect(screen.getByText(/^\d+ of \d+$/)).toBeInTheDocument();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^BUNDLES/ }));
    expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull();
    fireEvent.click(screen.getByTestId("floating-search-kind-pill"));
    expect(screen.getByText(/^\d+ of \d+$/)).toBeInTheDocument();
  });

  it("9. a 'j' keystroke in the bar types into the query rather than moving the list (m14e)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    await userEvent.type(input, "j");
    expect(input).toHaveValue("j");
  });

  it("10a. a fully empty registry (no skills, no bundles, no snippets) hides the dock", async () => {
    const empty: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
    await renderLibrary(empty, []);
    expect(screen.queryByTestId("floating-search")).toBeNull();
  });

  it("10b. no skills but a bundle exists still shows the bar (m12)", async () => {
    const noSkills: Registry = { ...sampleRegistry, skills: {} };
    await renderLibrary(noSkills, []);
    expect(screen.getByTestId("floating-search")).toBeInTheDocument();
  });

  it("10c. no skills but a snippet exists still shows the bar (m12)", async () => {
    const noSkills: Registry = { ...sampleRegistry, skills: {}, bundles: {} };
    await renderLibrary(noSkills, SNIPPET_FIXTURE);
    expect(screen.getByTestId("floating-search")).toBeInTheDocument();
  });

  it("11. chip counts are query-scoped", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");
    const bundlesChip = within(kindsRow()).getByRole("button", { name: /^BUNDLES/ });
    expect(within(bundlesChip).getByText("1")).toBeInTheDocument();
    const snippetsChip = within(kindsRow()).getByRole("button", { name: /^SNIPPETS/ });
    expect(within(snippetsChip).getByText("0")).toBeInTheDocument();
  });

  it("12. Enter opens the cursor row — reset to 0 on every query change (G9) — even after the list's own nav moved elsewhere; G13: `true` means the host navigated", async () => {
    await renderLibrary();
    const row0 = document.querySelectorAll(".lib-nav-row")[0] as HTMLElement;
    row0.focus();
    fireEvent.keyDown(row0, { key: "j" });
    expect(document.querySelector('[data-listnav-active="true"]')).not.toBe(row0);

    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    // "brainstorm" matches only the brainstorm SKILL — no bundle/snippet in
    // this fixture contains it — so the reset cursor lands on a skill row
    // regardless of the G1 cross-entity-first ordering.
    await userEvent.type(input, "brainstorm");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm");
  });

  it("13. facet-scoped counts: the SKILLS chip matches the facet-filtered list (m14a / G6)", async () => {
    await renderLibrary();
    await applySourceFacet();
    const listSkillRows = document.querySelectorAll(".lib-list .skill-row");
    expect(listSkillRows.length).toBe(1); // android-compose-ui (org-skills)

    fireEvent.focus(screen.getByTestId("floating-search-input"));
    const skillsChip = within(kindsRow()).getByRole("button", { name: /^SKILLS/ });
    expect(within(skillsChip).getByText(String(listSkillRows.length))).toBeInTheDocument();
  });

  it("14. a query matching only a bundle's description (zero skills) renders solely the BUNDLES group", async () => {
    await renderLibrary();
    // "workflows" hits only the android bundle's description — no skill or
    // snippet in the fixture contains it.
    await userEvent.type(screen.getByTestId("floating-search-input"), "workflows");
    expect(screen.queryByText("No matching skills")).toBeNull();
    expect(document.querySelector(".lib-list")).toBeNull();
    expect(sectionLabel("BUNDLES")).toBeInTheDocument();
    expect(screen.queryByText("SNIPPETS", { selector: ".section-label" })).toBeNull();
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "bundle");
    expect(hit).toHaveAttribute("data-id", "android");
  });

  it("15. no match anywhere (kind = all) shows the plain empty state, no groups", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "zzz-nothing-matches-this");
    expect(screen.getByText("No matching skills")).toBeInTheDocument();
    expect(screen.queryByTestId("library-body-hit")).toBeNull();
  });

  it("16. Enter with a query and no matching skills navigates to the first cross-entity body row's route (G13)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    await userEvent.type(input, "review");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("loc")).toHaveTextContent("/snippet/review-checklist");
  });

  it("17. a query matching a skill, a bundle, AND a snippet: groups render BUNDLES, then SNIPPETS, then the skill groups (review M2/m3)", async () => {
    const snippets: SnippetInfo[] = [
      ...SNIPPET_FIXTURE,
      {
        name: "android-conventions",
        description: "Project conventions for Android.",
        tags: ["android"],
        version: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        hash: "sha-android-conventions",
      },
    ];
    await renderLibrary(sampleRegistry, snippets);
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");

    const headingOrder = Array.from(
      document.querySelectorAll(".section-header .section-label"),
    ).map((el) => el.textContent);
    const bundlesAt = headingOrder.indexOf("BUNDLES");
    const snippetsAt = headingOrder.indexOf("SNIPPETS");
    const firstSkillGroupAt = headingOrder.findIndex(
      (t) => t === "GLOBAL" || t === "PORTABLE" || t === "PROJECT",
    );
    expect(bundlesAt).toBeGreaterThanOrEqual(0);
    expect(snippetsAt).toBeGreaterThan(bundlesAt);
    expect(firstSkillGroupAt).toBeGreaterThan(snippetsAt);

    // Each match appears exactly once.
    const bundleHitRows = screen
      .getAllByTestId("library-body-hit")
      .filter((el) => el.dataset.kind === "bundle" && el.dataset.id === "android");
    const snippetHitRows = screen
      .getAllByTestId("library-body-hit")
      .filter((el) => el.dataset.kind === "snippet" && el.dataset.id === "android-conventions");
    expect(bundleHitRows).toHaveLength(1);
    expect(snippetHitRows).toHaveLength(1);
    expect(document.querySelectorAll(".lib-list .skill-row").length).toBe(2); // rt-android-expert + android-compose-ui
  });

  it("18. grid view: a bundle match still renders as a body-hit row under BUNDLES (review m4)", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: "Grid view" }));
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");

    expect(document.querySelector(".skill-grid.lib-grid")).not.toBeNull();
    expect(sectionLabel("BUNDLES")).toBeInTheDocument();
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "bundle");
    expect(hit).toHaveAttribute("data-id", "android");
  });

  it("19. a facet with zero matching skills shows the facet hint, even when a cross-entity group still renders below it (review m6)", async () => {
    await renderLibrary();
    await applySourceFacet(); // source: org-skills -> only android-compose-ui passes
    // "workflows" hits only the android bundle's OWN description — the one
    // facet-passing skill doesn't match it, so `filtered` is empty even
    // though the BUNDLES group still renders below: exactly the case the
    // facet hint exists for (a bundle match must not stand in as "nothing is
    // wrong").
    await userEvent.type(screen.getByTestId("floating-search-input"), "workflows");

    expect(
      screen.getByText("No skills match the current source or trigger filter."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No matching skills")).toBeNull();
    expect(sectionLabel("BUNDLES")).toBeInTheDocument();
  });

  // ─── Wave 2: content search (band B) ────────────────────────────────────

  it("20. a body-only marker word renders that skill's row WITH an excerpt+mark, and skips skills whose bodies lack it", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, {
      skills: {
        brainstorm: "This body mentions zzzmarker deep inside a paragraph about brainstorming rounds.\n",
      },
      snippets: {},
    });
    await userEvent.type(screen.getByTestId("floating-search-input"), "zzzmarker");

    // The corpus fetch (and the re-render it drives) is async — poll rather
    // than assert synchronously right after typing.
    await waitFor(() => {
      expect(document.querySelector(".resource-excerpt")).not.toBeNull();
    });
    const excerpt = document.querySelector(".resource-excerpt")!;
    const mark = excerpt.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent("zzzmarker");
    expect(document.querySelector('.resource-name[title="brainstorm"]')).toBeInTheDocument();
    // No other skill's body contains the marker.
    expect(document.querySelector('.resource-name[title="fs-mcp"]')).toBeNull();
  });

  it("21. typing a skill's exact name still renders that row (band A), with no excerpt attached", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, {
      skills: {
        brainstorm: "This body mentions zzzmarker deep inside a paragraph about brainstorming rounds.\n",
      },
      snippets: {},
    });
    await userEvent.type(screen.getByTestId("floating-search-input"), "brainstorm");

    await waitFor(() => {
      expect(document.querySelector('.resource-name[title="brainstorm"]')).toBeInTheDocument();
    });
    const row = document.querySelector('.resource-name[title="brainstorm"]')!.closest(".skill-row")!;
    expect(row.querySelector(".resource-excerpt")).toBeNull();
  });

  it("22. the SKILLS chip count rises when the query is a body-only word (content matches are counted)", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, {
      skills: {
        brainstorm: "This body mentions zzzmarker deep inside a paragraph about brainstorming rounds.\n",
      },
      snippets: {},
    });
    await userEvent.type(screen.getByTestId("floating-search-input"), "zzzmarker");
    await waitFor(() => {
      expect(document.querySelector(".resource-excerpt")).not.toBeNull();
    });

    const skillsChip = within(kindsRow()).getByRole("button", { name: /^SKILLS/ });
    expect(within(skillsChip).getByText("1")).toBeInTheDocument();
  });

  it("23. a body-only word matching only a SNIPPET renders the SNIPPETS group with its excerpt, no empty state", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, {
      skills: {},
      snippets: {
        "review-checklist": "This checklist body mentions zzzsnippetmark right here.\n",
      },
    });
    await userEvent.type(screen.getByTestId("floating-search-input"), "zzzsnippetmark");

    await waitFor(() => {
      expect(sectionLabel("SNIPPETS")).toBeInTheDocument();
    });
    expect(screen.queryByText("No matching skills")).toBeNull();
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "snippet");
    expect(hit).toHaveAttribute("data-id", "review-checklist");
    const mark = within(hit).getByText("zzzsnippetmark");
    expect(mark.tagName).toBe("MARK");
  });

  it("24. a bundle/snippet body-hit row's description-only match renders a <mark> inside .resource-desc", async () => {
    await renderLibrary();
    // "workflows" is only in the android bundle's own description.
    await userEvent.type(screen.getByTestId("floating-search-input"), "workflows");

    const hit = await screen.findByTestId("library-body-hit");
    const descMark = within(hit).getByText("workflows");
    expect(descMark.tagName).toBe("MARK");
  });

  it("24b. a skill row's own description-only match renders a <mark> inside its .resource-desc too (M2)", async () => {
    await renderLibrary();
    // "planner" is in rt-android-expert's DESCRIPTION only (band A tier 5).
    await userEvent.type(screen.getByTestId("floating-search-input"), "planner");

    const nameEl = document.querySelector('.resource-name[title="rt-android-expert"]')!;
    const row = nameEl.closest(".skill-row")!;
    const descMark = row.querySelector(".resource-desc mark");
    expect(descMark).not.toBeNull();
    expect(descMark).toHaveTextContent("planner");
  });

  it("25. read_search_corpus rejecting still filters by name (band A) with no error shown", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, "reject");
    await userEvent.type(screen.getByTestId("floating-search-input"), "android");

    expect(document.querySelector('.resource-name[title="rt-android-expert"]')).toBeInTheDocument();
    expect(document.querySelector('.resource-name[title="android-compose-ui"]')).toBeInTheDocument();
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  // ─── S2/S3/G1/G3/G6/G9/G10/G13: the arrow-cursor + Tab + reset contract ──

  it("26. ArrowDown from the input moves the cursor from the BUNDLES body row into a skill row, without moving DOM focus off the input (S2/G1)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "android");

    // G9: the reset cursor (row 0) is the BUNDLES body hit — cross-entity
    // rows render before the skill rows (G1).
    const row0 = document.querySelector('[data-listnav-active="true"]')!;
    expect(row0.querySelector('[data-testid="library-body-hit"]')).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    const active = document.querySelector('[data-listnav-active="true"]')!;
    expect(active.querySelector(".skill-row")).not.toBeNull();
    expect(input).toHaveFocus();
    expect(active).not.toHaveFocus();
  });

  it("27. Enter opens the cursor row even when it's a cross-entity BUNDLES hit — navigates to /bundle/:name (G13)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "android");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc")).toHaveTextContent("/bundle/android");
  });

  it("28. switching the kind filter resets the arrow-cursor to row 0 — not merely clamped (G9)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "android");
    // 3 results (1 bundle + 2 skills) — move off row 0 onto a skill row.
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // Switch to SKILLS: the cross-entity row drops out (2 results remain),
    // so the OLD index (1) would still be a valid, unchanged position under
    // pure clamping — only an explicit reset moves it back to row 0.
    fireEvent.click(within(kindsRow()).getByRole("button", { name: /^SKILLS/ }));

    const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
    expect(rows).toHaveLength(2);
    const activeIdx = rows.findIndex(
      (r) => r.getAttribute("data-listnav-active") === "true",
    );
    expect(activeIdx).toBe(0);
  });

  it("29. grid view: ArrowDown from the input paints the lit slot on a SkillCard, crossing from the BUNDLES row (G10)", async () => {
    await renderLibrary();
    await userEvent.click(screen.getByRole("button", { name: "Grid view" }));
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "android");

    fireEvent.keyDown(input, { key: "ArrowDown" });

    const active = document.querySelector('[data-listnav-active="true"]')!;
    expect(active.querySelector(".resource-card")).not.toBeNull();
  });

  it("30. Tab from the input focuses the BUNDLES cursor row; `j` on it crosses into the skill rows (G1/G3)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "android");

    fireEvent.keyDown(input, { key: "Tab" });
    const row0 = document.querySelector('[data-listnav-active="true"]')!;
    expect(row0).toHaveFocus();
    expect(row0.querySelector('[data-testid="library-body-hit"]')).not.toBeNull();

    fireEvent.keyDown(row0, { key: "j" });
    const active = document.querySelector('[data-listnav-active="true"]')!;
    expect(active.querySelector(".skill-row")).not.toBeNull();
  });

  it("34. Grill MINOR 6: changing the SOURCE facet resets the arrow-cursor to row 0, same as a query/kind change (G9)", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    fireEvent.focus(input);
    // No query: 4 skill rows, no cross-entity hits — move the cursor to
    // row 2 before touching the facet.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const before = Array.from(document.querySelectorAll(".lib-nav-row")).findIndex(
      (r) => r.getAttribute("data-listnav-active") === "true",
    );
    expect(before).toBe(2);

    await applySourceFacet(); // source: org-skills -> narrows to 1 row

    const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
    const activeIdx = rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
    expect(activeIdx).toBe(0);
  });

  it("35. Grill MINOR 7: the live region announces nothing on mount with an empty query and kind = all", async () => {
    await renderLibrary();
    expect(screen.getByTestId("library-search-live")).toHaveTextContent("");
  });

  it("33. Grill MAJOR 2: zero skills but a bundle match exists — the empty-registry state renders zero rows, so Enter must not navigate to the invisible bundle hit", async () => {
    const noSkills: Registry = { ...sampleRegistry, skills: {} };
    await renderLibrary(noSkills, []);
    // Sanity: the registry-empty state is on screen (no result rows at all).
    expect(screen.getByText("Create your first skill")).toBeInTheDocument();

    const input = screen.getByTestId("floating-search-input");
    // "android" matches the android bundle's own name/description — the
    // cross-entity pool includes bundles regardless of the skill count.
    await userEvent.type(input, "android");
    expect(screen.queryByTestId("library-body-hit")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // Still on the Library route — nothing was navigated to.
    expect(screen.queryByTestId("loc")).toBeNull();
  });
});

// ─── Wave 2: URL list state + return-with-attention (R1-R5, H1-H10) ─────────
describe("SkillLibrary — list state in the URL, and returning with attention", () => {
  it("R1: mounting at /?q=an&kind=bundle applies the query and kind filter from the URL", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS, "/?q=an&kind=bundle");
    expect(screen.getByTestId("floating-search-input")).toHaveValue("an");
    expect(screen.getByTestId("floating-search-kind-pill")).toHaveTextContent("BUNDLES");
    const hit = screen.getByTestId("library-body-hit");
    expect(hit).toHaveAttribute("data-kind", "bundle");
    expect(hit).toHaveAttribute("data-id", "android");
  });

  it("R1: an invalid kind/trigger in the URL reads as the default (no crash, no pill)", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS, "/?kind=bogus&trigger=nonsense");
    expect(screen.queryByTestId("floating-search-kind-pill")).toBeNull();
  });

  it("R1: the one-shot ?new=1 strip keeps q in the URL (list state survives the strip)", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS, "/?q=an&new=1");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveValue("an"));
  });

  // Finding 4: the one-shot strips now build `next` from the FUNCTIONAL
  // `setSearchParams` form (reads params fresh at write time) instead of the
  // render-time `searchParams` closure, matching the pattern every other
  // list-state write in this file already follows. Pinned end to end: the
  // strip removes `new` and keeps `q`, and a further list-state write
  // (`kind`) never resurrects it. (This specific ordering did not reproduce
  // a failure against the pre-fix closure-capture form in this component
  // tree — `SkillLibrary` and `useLibraryListState` share one
  // `useSearchParams()` subscription and always recommit together — so this
  // is a defensive/consistency regression pin, not a demonstrated-failing
  // race.)
  it("R1/finding 4: with ?new=1&q=an, the strip leaves q=an and removes new — and a further kind write never resurrects it", async () => {
    mockInvoke(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS);
    renderWithProviders(
      <>
        <Routes>
          <Route path="/" element={<SkillLibrary />} />
        </Routes>
        <LocationProbe />
      </>,
      { client: makeQueryClient(), initialRoute: "/?q=an&new=1" },
    );
    const input = await screen.findByTestId("floating-search-input");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      const search = screen.getByTestId("loc").dataset.search ?? "";
      expect(search).toContain("q=an");
      expect(search).not.toContain("new");
    });

    fireEvent.focus(input);
    const skillsChip = within(kindsRow()).getByRole("button", { name: /^SKILLS/ });
    await userEvent.click(skillsChip);

    await waitFor(() => {
      const search = screen.getByTestId("loc").dataset.search ?? "";
      expect(search).toContain("q=an");
      expect(search).toContain("kind=skill");
      expect(search).not.toContain("new");
    });
  });

  it("R4: a fresh / (no params) shows an empty query and no stolen focus", async () => {
    await renderLibrary();
    expect(screen.getByTestId("floating-search-input")).toHaveValue("");
    expect(screen.getByTestId("floating-search-input")).not.toHaveFocus();
  });

  it("R2/H6: Enter from the bar stamps a libReturn (focus:'bar') and the new route's referrer carries the same payload plus the search string", async () => {
    await renderLibrary();
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "brainstorm");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("loc")).toHaveTextContent("/skill/brainstorm");
    const state = JSON.parse(screen.getByTestId("loc").dataset.state ?? "null");
    expect(state.from).toEqual({
      label: "Library",
      path: "/?q=brainstorm",
      crumbs: ["library"],
      // Finding 9: `restore` is the WHOLE state object the Library wants
      // back, opaque to `backTarget.ts` — wrapped as `{ libReturn }` HERE,
      // not by `backReturnOptions`.
      restore: { libReturn: { cursorKey: "skill:brainstorm", focus: "bar" } },
    });
  });

  it("R2: a click-open stamps focus:'none'", async () => {
    await renderLibrary();
    await userEvent.type(screen.getByTestId("floating-search-input"), "brainstorm");
    fireEvent.click(document.querySelector('.resource-name[title="brainstorm"]')!.closest(".skill-row")!);

    const state = JSON.parse(screen.getByTestId("loc").dataset.state ?? "null");
    expect(state.from.restore).toEqual({
      libReturn: { cursorKey: "skill:brainstorm", focus: "none" },
    });
  });

  // Finding 3: these two used a query ("brainstorm") whose only match is the
  // target itself — the restored row landed at flatItems[0], which is also
  // `useListNav`'s own synchronous default. Deleting the restore effect
  // entirely left both passing. "android" matches the bundle (index 0) AND
  // two skills (index 1/2, one of which is NOT the exact-name-prefix
  // winner) — restoring to "rt-android-expert" (index 2, after both the
  // bundle hit and android-compose-ui) can only be right if the restore
  // effect actually ran.
  it("R3/H6: mounting with a pending libReturn(focus:'bar') restores the cursor to that row, focuses the bar, then clears the payload", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS, {
      pathname: "/",
      search: "?q=android",
      state: { libReturn: { cursorKey: "skill:rt-android-expert", focus: "bar" } },
    });

    await waitFor(() => {
      const active = document.querySelector('[data-listnav-active="true"]');
      expect(active?.querySelector('.resource-name[title="rt-android-expert"]')).not.toBeNull();
    });
    // Not the row a synchronous "always 0" default would land on.
    const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
    const activeIdx = rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
    expect(activeIdx).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveFocus());
  });

  it("R3/H6: focus:'none' (a click-open) restores the cursor but never steals focus back to the bar", async () => {
    await renderLibrary(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS, {
      pathname: "/",
      search: "?q=android",
      state: { libReturn: { cursorKey: "skill:rt-android-expert", focus: "none" } },
    });

    await waitFor(() => {
      const active = document.querySelector('[data-listnav-active="true"]');
      expect(active?.querySelector('.resource-name[title="rt-android-expert"]')).not.toBeNull();
    });
    const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
    const activeIdx = rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
    expect(activeIdx).toBeGreaterThan(0);
    expect(screen.getByTestId("floating-search-input")).not.toHaveFocus();
  });

  // Finding 3: landing on row 0 is indistinguishable from "the restore
  // effect never ran at all" (`useListNav`'s own synchronous default is also
  // 0) — so the decisive assertion here is that the give-up path actually
  // CONSUMED and cleared the pending payload from history state, which only
  // happens if the effect ran. A deleted restore effect would leave
  // `libReturn` sitting in state forever.
  it("R3/H4: an unknown cursorKey lands the cursor on row 0 once every settling query resolves, instead of retrying forever", async () => {
    mockInvoke(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS);
    renderWithProviders(
      <>
        <Routes>
          <Route path="/" element={<SkillLibrary />} />
        </Routes>
        <LocationProbe />
      </>,
      {
        client: makeQueryClient(),
        initialRoute: {
          pathname: "/",
          search: "",
          state: { libReturn: { cursorKey: "skill:does-not-exist", focus: "bar" } },
        },
      },
    );
    await screen.findByTestId("floating-search-input");
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
      const activeIdx = rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
      expect(activeIdx).toBe(0);
    });
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("loc").dataset.state ?? "null");
      expect(state?.libReturn).toBeUndefined();
    });
  });

  it("H4: a cursorKey that only becomes valid once the snippet-names query resolves is found on retry, not abandoned", async () => {
    let resolveSnippets: (v: SnippetInfo[]) => void = () => {};
    const snippetsPromise = new Promise<SnippetInfo[]>((res) => {
      resolveSnippets = res;
    });
    // Finding 3: "review" alone matches ONLY the snippet fixture — the
    // restored row would land at flatItems[0] even with the restore effect
    // deleted. A bundle whose NAME also matches "review" (available
    // immediately, from the registry — no promise to wait on) sorts before
    // any snippet hit (`crossFlatItems` is always bundleHits THEN
    // snippetHits), so the target only reaches a non-zero index once the
    // delayed snippet resolves and the retry logic actually finds it.
    const registryWithReviewBundle: Registry = {
      ...sampleRegistry,
      bundles: {
        ...sampleRegistry.bundles,
        "review-tools": {
          description: "Checklist tools for review",
          icon: "🧭",
          scope: "project-specific",
          skills: [],
        },
      },
    };
    mockCommands({
      read_registry: registryWithReviewBundle,
      snippets_list: snippetsPromise,
      local_skill_candidates: [],
      harness_list: [],
      hub_cmd: { success: true, output: '{"sources":[],"errors":[]}' },
      read_search_corpus: EMPTY_CORPUS,
    });

    renderWithProviders(
      <Routes>
        <Route path="/" element={<SkillLibrary />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        client: makeQueryClient(),
        initialRoute: {
          pathname: "/",
          search: "?q=review",
          state: { libReturn: { cursorKey: "snippet:review-checklist", focus: "none" } },
        },
      },
    );
    await screen.findByTestId("floating-search-input");

    // Before the snippet resolves, the only visible cross-entity hit is the
    // bundle — the target key can't be found yet.
    await waitFor(() => {
      const bundleRow = document.querySelector(
        '[data-testid="library-body-hit"][data-kind="bundle"][data-id="review-tools"]',
      );
      expect(bundleRow).not.toBeNull();
    });

    resolveSnippets(SNIPPET_FIXTURE);

    await waitFor(() => {
      const active = document.querySelector('[data-listnav-active="true"]');
      const hit = active?.querySelector('[data-testid="library-body-hit"]');
      expect(hit).toHaveAttribute("data-kind", "snippet");
      expect(hit).toHaveAttribute("data-id", "review-checklist");
    });
    // Not the row a synchronous "always 0" default (or a give-up-early bug)
    // would land on — the bundle hit is index 0.
    const rows = Array.from(document.querySelectorAll(".lib-nav-row"));
    const activeIdx = rows.findIndex((r) => r.getAttribute("data-listnav-active") === "true");
    expect(activeIdx).toBeGreaterThan(0);
  });

  it("H10: a real history pop (navigate(-1)) restores the query, cursor, and focus — not just a remount with hand-built state", async () => {
    mockInvoke(sampleRegistry, SNIPPET_FIXTURE, EMPTY_CORPUS);
    renderWithProviders(
      <Routes>
        <Route path="/" element={<SkillLibrary />} />
        <Route path="/skill/:name" element={<GoBackProbe />} />
      </Routes>,
      { client: makeQueryClient() },
    );
    await screen.findByTestId("floating-search-input");
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "brainstorm");
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText("go back");
    fireEvent.click(screen.getByText("go back"));

    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveValue("brainstorm"));
    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveFocus());
    const active = document.querySelector('[data-listnav-active="true"]')!;
    expect(active.querySelector('.resource-name[title="brainstorm"]')).not.toBeNull();
  });

  // Finding 1: `ScreenHeader`'s AUTO back arrow (no explicit `back` prop —
  // the path SnippetEditor and every referrer-following screen use) used to
  // `navigate(referrer.path)` with no options, dropping the `restore`
  // payload H1 requires. A registry with a BUNDLE that also matches "review"
  // (available immediately, unlike the snippet, mirroring the H4 fixture
  // above) puts the snippet body-hit at index 1, not 0 — so this can only
  // pass if the back arrow actually carried `libReturn` through
  // `backReturnOptions`, not by luck of a synchronous "always 0" default.
  it("H1: ScreenHeader's automatic back arrow restores a snippet body-hit's query, cursor, and bar focus", async () => {
    const registryWithReviewBundle: Registry = {
      ...sampleRegistry,
      bundles: {
        ...sampleRegistry.bundles,
        "review-tools": {
          description: "Checklist tools for review",
          icon: "🧭",
          scope: "project-specific",
          skills: [],
        },
      },
    };
    mockInvoke(registryWithReviewBundle, SNIPPET_FIXTURE, EMPTY_CORPUS);
    renderWithProviders(
      <Routes>
        <Route path="/" element={<SkillLibrary />} />
        <Route
          path="/snippet/:name"
          element={<ScreenHeader icon="snippet" title="review-checklist" />}
        />
      </Routes>,
      { client: makeQueryClient() },
    );
    await screen.findByTestId("floating-search-input");
    const input = screen.getByTestId("floating-search-input");
    await userEvent.type(input, "review");

    // Cursor resets to 0 (the bundle hit) on every query change (G9) — move
    // it onto the snippet hit (index 1) before opening it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const before = document.querySelector('[data-listnav-active="true"] [data-testid="library-body-hit"]');
    expect(before).toHaveAttribute("data-kind", "snippet");
    expect(before).toHaveAttribute("data-id", "review-checklist");

    fireEvent.keyDown(input, { key: "Enter" });

    const back = await screen.findByRole("button", { name: "Back to Library" });
    fireEvent.click(back);

    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveValue("review"));
    await waitFor(() => expect(screen.getByTestId("floating-search-input")).toHaveFocus());
    const active = document.querySelector('[data-listnav-active="true"] [data-testid="library-body-hit"]');
    expect(active).toHaveAttribute("data-kind", "snippet");
    expect(active).toHaveAttribute("data-id", "review-checklist");
  });
});
