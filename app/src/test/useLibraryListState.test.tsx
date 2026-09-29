import { useRef } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useLibraryListState } from "@/hooks/useLibraryListState";

const WRITE_STATE = "__skillHubLibraryListWrite";

/** Exercises `useLibraryListState` through a plain consumer — the hook has
 *  no view of its own, so every assertion reads back either the derived
 *  values or the URL/history behaviour `patch()` produces. `location.search`
 *  (not just the hook's own `q` readback, which is LOCAL state and would
 *  read correctly even if the mirror write to the URL never landed) is what
 *  finding 2's rewritten tests below actually pin. */
function Probe() {
  const state = useLibraryListState();
  const navigate = useNavigate();
  const location = useLocation();
  const remembered = useRef(location);
  return (
    <div>
      <span data-testid="q">{state.q}</span>
      <span data-testid="kind">{state.kind}</span>
      <span data-testid="source">{state.source ?? "∅"}</span>
      <span data-testid="trigger">{state.trigger}</span>
      <span data-testid="class">{state.classFilter ?? "∅"}</span>
      <span data-testid="mode">{state.mode}</span>
      <span data-testid="class-scope">{state.classificationScope}</span>
      <span data-testid="url-search">{location.search}</span>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="hash">{location.hash}</span>
      <span data-testid="state">{JSON.stringify(location.state)}</span>
      <button onClick={() => state.patch({ q: "an" })}>patchQ</button>
      <button onClick={() => state.patch({ kind: "bundle" })}>patchKind</button>
      <button onClick={() => state.patch({ q: "" })}>clearQ</button>
      <button onClick={() => state.patch({ source: "org-skills", trigger: "auto" })}>
        patchBoth
      </button>
      <button onClick={() => state.patch({ source: null, trigger: "all" })}>
        clearFacets
      </button>
      <button onClick={() => {
        state.patch({ mode: "mixed" });
        state.patch({ classificationScope: "assigned" });
      }}>
        patchClassificationTwice
      </button>
      <button onClick={() => {
        state.patch({ q: "android" });
        state.patch({ mode: "mixed" });
      }}>
        patchQueryThenMode
      </button>
      <button onClick={() => navigate(-1)}>back</button>
      {/* Finding 5: same-route navigation to a fresh "/" (the rail, `g l`) —
       *  clears the URL's own `q`/`kind`/`source`/`trigger` with no state,
       *  the same shape a real "go to Library" produces. */}
      <button onClick={() => navigate("/")}>fresh</button>
      <button onClick={() => { state.patch({ q: "older" }); state.patch({ q: "newer", mode: "mixed" }); navigate("/?q=older", { replace: true, state: { libReturn: "older" } }); }}>externalOlder</button>
      <button onClick={() => { state.patch({ q: "pending" }); navigate("/other?q=android#target", { state: { from: "external" } }); }}>otherRoute</button>
      <button onClick={() => navigate("/?q=next")}>advance</button>
      <button onClick={() => { remembered.current = location; }}>remember</button>
      <button onClick={() => navigate(remembered.current, { replace: true, state: remembered.current.state })}>replay</button>
      <button onClick={() => {
        const next = { ...location.state };
        delete next.libReturn;
        navigate(location, { replace: true, state: next });
      }}>consumeReturn</button>
    </div>
  );
}

/** A sibling entry BEFORE the Library one, so a "did `patch()` push a new
 *  history entry" check is a single `navigate(-1)` away from a route this
 *  test can positively identify. */
function renderProbe(
  entry: string | { pathname: string; search?: string; state?: unknown } = "/",
) {
  return render(
    <MemoryRouter initialEntries={["/outside", entry]} initialIndex={1}>
      <Routes>
        <Route path="/outside" element={<div data-testid="outside">outside</div>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("useLibraryListState", () => {
  it("reads all-default when the URL carries no list-state params", () => {
    renderProbe();
    expect(screen.getByTestId("q")).toHaveTextContent("");
    expect(screen.getByTestId("kind")).toHaveTextContent("all");
    expect(screen.getByTestId("source")).toHaveTextContent("∅");
    expect(screen.getByTestId("trigger")).toHaveTextContent("all");
  });

  it("reads q and a valid kind/trigger/source straight from the URL", () => {
    renderProbe("/?q=an&kind=bundle&source=org-skills&trigger=auto");
    expect(screen.getByTestId("q")).toHaveTextContent("an");
    expect(screen.getByTestId("kind")).toHaveTextContent("bundle");
    expect(screen.getByTestId("source")).toHaveTextContent("org-skills");
    expect(screen.getByTestId("trigger")).toHaveTextContent("auto");
  });

  it("reads and serializes classification facets with the list return search", () => {
    renderProbe("/?class=process&mode=mixed&classScope=assigned");
    expect(screen.getByTestId("class")).toHaveTextContent("process");
    expect(screen.getByTestId("mode")).toHaveTextContent("mixed");
    expect(screen.getByTestId("class-scope")).toHaveTextContent("assigned");
  });

  it("an invalid kind falls back to 'all' rather than throwing or passing it through", () => {
    renderProbe("/?kind=nonsense");
    expect(screen.getByTestId("kind")).toHaveTextContent("all");
  });

  it("an invalid trigger falls back to 'all'", () => {
    renderProbe("/?trigger=bogus");
    expect(screen.getByTestId("trigger")).toHaveTextContent("all");
  });

  it("an unknown source id is NOT normalized here — it reads through as-is (H7: the caller decides what 'unknown' means)", () => {
    renderProbe("/?source=deleted-source");
    expect(screen.getByTestId("source")).toHaveTextContent("deleted-source");
  });

  it("patch() writes via replace — never grows the history stack", () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    fireEvent.click(screen.getByText("patchKind"));
    // Two independent patches, each a `replace` — one `back` step still lands
    // on the entry BEFORE the Library, proving neither patch pushed one.
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("outside")).toBeInTheDocument();
  });

  // Finding 2: a `q`-only `patch()` no longer writes the URL itself — it sets
  // local state and lets the mirror `useEffect` (on `[q]`) do the write, with
  // NO timer in between. These two tests pin the actual URL write (via
  // `location.search`, not just the hook's own `q` readback) and the replace
  // semantics that write carries.
  it("a `q`-only patch() mirrors to location.search via replace — MemoryRouter's entry count is unchanged", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=an"));

    fireEvent.click(screen.getByText("back"));
    // A `push` would have landed one step further back than `outside` — a
    // `replace` lands on it in one step, same as the pure-`kind` case above.
    expect(screen.getByTestId("outside")).toBeInTheDocument();
  });

  it("a `q`-only patch() writes q= to the URL; clearing it back to the default deletes the param", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=an"));

    fireEvent.click(screen.getByText("clearQ"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent(""));
  });

  it("a default-valued write deletes the param instead of writing q=/kind=all", () => {
    renderProbe("/?q=an&kind=bundle");
    fireEvent.click(screen.getByText("clearQ"));
    expect(screen.getByTestId("q")).toHaveTextContent("");
    // kind untouched by this patch call.
    expect(screen.getByTestId("kind")).toHaveTextContent("bundle");
  });

  it("H3: one patch() call writes BOTH keys — a two-key change never partially clobbers itself", () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchBoth"));
    expect(screen.getByTestId("source")).toHaveTextContent("org-skills");
    expect(screen.getByTestId("trigger")).toHaveTextContent("auto");

    fireEvent.click(screen.getByText("clearFacets"));
    expect(screen.getByTestId("source")).toHaveTextContent("∅");
    expect(screen.getByTestId("trigger")).toHaveTextContent("all");
  });

  it("keeps separate same-render classification patches in the URL", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchClassificationTwice"));

    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?mode=mixed&classScope=assigned"));
  });

  it("keeps a staged query when a same-render facet patch follows", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQueryThenMode"));

    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId("url-search").textContent ?? "");
      expect(params.get("q")).toBe("android");
      expect(params.get("mode")).toBe("mixed");
    });
  });

  it("lets an external older query win over pending writes", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("externalOlder"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=older"));
    expect(screen.getByTestId("q")).toHaveTextContent("older");
  });

  it("treats a same-query route change as external", async () => {
    renderProbe("/?q=android");
    fireEvent.click(screen.getByText("otherRoute"));
    await waitFor(() => expect(screen.getByTestId("pathname")).toHaveTextContent("/other"));
    expect(screen.getByTestId("url-search")).toHaveTextContent("?q=android");
    expect(screen.getByTestId("q").textContent).toBe("android");
    fireEvent.click(screen.getByText("patchKind"));
    expect(screen.getByTestId("url-search").textContent).toBe("?q=android&kind=bundle");
  });

  it.each(["plain-state", ["saved", "state"], 42])("preserves nonplain state through a list write: %j", async (savedState) => {
    renderProbe({ pathname: "/", state: savedState });
    fireEvent.click(screen.getByText("patchQ"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=an"));
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual(savedState);
  });

  it("treats POP to an old marked entry as external", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    expect(JSON.parse(screen.getByTestId("state").textContent!)[WRITE_STATE]).toBeDefined();
    fireEvent.click(screen.getByText("advance"));
    fireEvent.click(screen.getByText("patchClassificationTwice"));
    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=an"));
    expect(screen.getByTestId("q")).toHaveTextContent("an");
    expect(screen.getByTestId("mode")).toHaveTextContent("all");
    fireEvent.click(screen.getByText("patchKind"));
    expect(screen.getByTestId("url-search").textContent).toBe("?q=an&kind=bundle");
  });

  it("preserves a referrer and does not resurrect its consumed return state", async () => {
    renderProbe({ pathname: "/", state: { from: "original", libReturn: { skill: "saved" } } });
    fireEvent.click(screen.getByText("patchQ"));
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toMatchObject({ from: "original", libReturn: { skill: "saved" } });
    fireEvent.click(screen.getByText("remember"));
    fireEvent.click(screen.getByText("consumeReturn"));
    fireEvent.click(screen.getByText("patchKind"));
    fireEvent.click(screen.getByText("replay"));
    await waitFor(() => {
      const saved = JSON.parse(screen.getByTestId("state").textContent!);
      expect(saved.from).toBe("original");
      expect(saved).not.toHaveProperty("libReturn");
    });
  });

  it("keeps settled newer intent when an earlier own replacement arrives late", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    fireEvent.click(screen.getByText("remember"));
    fireEvent.click(screen.getByText("patchKind"));
    fireEvent.click(screen.getByText("replay"));
    await waitFor(() => expect(screen.getByTestId("url-search").textContent).toBe("?q=an&kind=bundle"));
  });

  it("restores the complete external destination after a superseded own replacement", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ"));
    fireEvent.click(screen.getByText("remember"));
    fireEvent.click(screen.getByText("otherRoute"));
    fireEvent.click(screen.getByText("replay"));
    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/other"));
    expect(screen.getByTestId("url-search").textContent).toBe("?q=android");
    expect(screen.getByTestId("hash").textContent).toBe("#target");
    expect(screen.getByTestId("q").textContent).toBe("android");
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toMatchObject({ from: "external" });
  });

  // A fresh navigation must supersede pending local query edits.
  it("R4/finding 5: navigating to a fresh / right after typing leaves q empty, not the stale keystroke", async () => {
    renderProbe();
    fireEvent.click(screen.getByText("patchQ")); // local q becomes "an"
    fireEvent.click(screen.getByText("fresh")); // navigate to a fresh list

    await waitFor(() => expect(screen.getByTestId("q")).toHaveTextContent(""));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent(""));
    // The abandoned local edit must not reappear after navigation settles.
    expect(screen.getByTestId("q")).toHaveTextContent("");
    expect(screen.getByTestId("url-search")).toHaveTextContent("");
  });
});
