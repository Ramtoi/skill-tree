import { describe, it, expect } from "vitest";
import { invoke } from "@/mocks/tauriCore";
import type { SearchCorpus } from "@/lib/unifiedSearch";

// The mocked-Tauri backend's search corpus (`src/mocks/tauriCore.ts`) is what
// `library-search.journey.spec.ts` and the `library-search-*` visual scenes
// render against. Two of that journey's assertions are NEGATIVES — "brainstorm"
// absent for the query "andr", "no skill row" for "conventions". The floating
// search also matches on BODY content, not just name, so the narrower
// property this test pins is: no BODY-ONLY hit — a skill's body may carry
// "andr" only when its own name already matches the query (the row is then
// visible either way, so the "brainstorm" negative still holds); a skill or
// snippet body matching "andr" or "conventions" with no matching name is the
// regression this guards against. Pinned once, in code, rather than left to
// be re-discovered by a flaky e2e failure the next time someone edits a body.

describe("mocked backend — search corpus fidelity", () => {
	it("no body-only hit for 'andr' or 'conventions' (the e2e negative-fixture constraint)", async () => {
		const corpus = await invoke<SearchCorpus>("read_search_corpus");
		// A body may mention "andr" only when its own NAME already matches the
		// query — then the row is visible either way and the negative ("brainstorm"
		// absent) still holds. A cross-reference to `rt-android-expert` inside
		// `android-compose-ui` is the sanctioned case; a mention inside `brainstorm`
		// is the regression this guards against.
		for (const [name, body] of Object.entries(corpus.skills)) {
			if (!name.toLowerCase().includes("andr")) {
				expect(body.toLowerCase(), `skill ${name}`).not.toContain("andr");
			}
			expect(body.toLowerCase(), `skill ${name}`).not.toContain("conventions");
		}
		for (const [name, body] of Object.entries(corpus.snippets)) {
			expect(body.toLowerCase(), `snippet ${name}`).not.toContain("andr");
			expect(body.toLowerCase(), `snippet ${name}`).not.toContain("conventions");
		}
	});

	it("the three marker words each appear in exactly their documented bodies, nowhere else", async () => {
		const corpus = await invoke<SearchCorpus>("read_search_corpus");

		const quorumSkills = Object.entries(corpus.skills).filter(([, b]) =>
			b.toLowerCase().includes("quorum"),
		);
		const quorumSnippets = Object.entries(corpus.snippets).filter(([, b]) =>
			b.toLowerCase().includes("quorum"),
		);
		expect(quorumSkills.map(([name]) => name)).toEqual(["brainstorm"]);
		expect(quorumSnippets.map(([name]) => name)).toEqual(["android-conventions"]);

		const lighthouseSkills = Object.entries(corpus.skills).filter(([, b]) =>
			b.toLowerCase().includes("lighthouse"),
		);
		const lighthouseSnippets = Object.entries(corpus.snippets).filter(([, b]) =>
			b.toLowerCase().includes("lighthouse"),
		);
		expect(lighthouseSkills.map(([name]) => name)).toEqual(["code-review"]);
		expect(lighthouseSnippets.map(([name]) => name)).toEqual(["review-checklist"]);

		const derivedStateOfSkills = Object.entries(corpus.skills).filter(([, b]) =>
			b.toLowerCase().includes("derivedstateof"),
		);
		expect(derivedStateOfSkills.map(([name]) => name)).toEqual(["rt-android-expert"]);
	});

	it("none of the three marker words appear in any name, description, or tag in the base registry/snippets", async () => {
		const registry = await invoke<{
			skills: Record<string, { description?: string }>;
		}>("read_registry");
		const snippets = await invoke<Array<{ name: string; description?: string; tags?: string[] }>>(
			"snippets_list",
			{ tag: null, query: null },
		);
		const markers = ["quorum", "lighthouse", "derivedstateof"];
		const haystacks = [
			...Object.entries(registry.skills).flatMap(([name, s]) => [name, s.description ?? ""]),
			...snippets.flatMap((s) => [s.name, s.description ?? "", ...(s.tags ?? [])]),
		].map((s) => s.toLowerCase());
		for (const marker of markers) {
			expect(haystacks.some((h) => h.includes(marker))).toBe(false);
		}
	});
});
