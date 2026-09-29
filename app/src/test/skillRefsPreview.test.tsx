import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { findRefs, type SkillRefHit, type SkillRefRenderOptions } from "@/lib/skillRefs";

// ─── Preview consumes previewHits as opaque tokens (grill M1) ────────────────
// No new INLINE_RULES entry and no re-scan: renderInline's pre-pass walks
// `previewHits` hits left to right and emits each as an atomic `.md-skill-ref`
// node. The corpus's `preview_hits` field pins the ONE Preview carve-out end
// to end (a fenced block never reaches the inline pass; an inline code span
// is excluded by `previewHits` itself) — see plans/INTERFACES.md.

interface SkillRefCorpusCase {
	name: string;
	text: string;
	names: string[];
	self: string | null;
	ignore: string[];
	expect: SkillRefHit[];
	counts: Record<string, number>;
	preview_hits: number;
}

const CORPUS = JSON.parse(
	readFileSync(
		resolve(process.cwd(), "../tests/fixtures/skill_refs_corpus.json"),
		"utf-8",
	),
) as {
	schema_version: number;
	cases: SkillRefCorpusCase[];
};

const DESCRIPTIONS: Record<string, string> = {
	"code-review": "Review the current diff for correctness bugs.",
};

function makeSkillRefs(
	names: string[],
	self: string | null,
	ignore: string[],
	onOpen: (name: string) => void = vi.fn(),
): SkillRefRenderOptions {
	return {
		names,
		self: self ?? undefined,
		ignore,
		describe: (name) => DESCRIPTIONS[name],
		onOpen,
	};
}

function renderMd(md: string, skillRefs?: SkillRefRenderOptions) {
	const { container } = render(<>{renderMarkdown(md, { skillRefs })}</>);
	const root = container.querySelector(".md-prose") as HTMLElement;
	return root;
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("renderMarkdown — skill-reference preview links", () => {
	it("renders a resolvable inline-code span as a ref button", () => {
		const onOpen = vi.fn();
		const skillRefs = makeSkillRefs(["code-review"], null, [], onOpen);
		const root = renderMd("see `code-review`", skillRefs);
		const link = root.querySelector("button.md-skill-ref") as HTMLButtonElement;
		expect(link).toBeTruthy();
		expect(link.textContent).toBe("code-review");
		expect(link.dataset.form).toBe("backtick");
		fireEvent.click(link);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledWith("code-review");
	});

	it("renders an unresolvable inline-code span as plain code", () => {
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd("see `ViewModel`", skillRefs);
		expect(root.querySelector(".md-skill-ref")).toBeNull();
		const code = root.querySelector("code.md-code-inline");
		expect(code).toBeTruthy();
		expect(code!.textContent).toBe("ViewModel");
	});

	it("renders a slash token from the pre-pass and keeps the surrounding text", () => {
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd("run /code-review now", skillRefs);
		const links = root.querySelectorAll(".md-skill-ref");
		expect(links).toHaveLength(1);
		expect((links[0] as HTMLElement).dataset.form).toBe("slash");
		expect(root.textContent).toBe("run /code-review now");
	});

	it("does not link a reference inside a multi-word inline code span", () => {
		const text = "`run /code-review`";
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd(text, skillRefs);
		expect(root.querySelector(".md-skill-ref")).toBeNull();
		const code = root.querySelector("code.md-code-inline");
		expect(code).toBeTruthy();
		expect(code!.textContent).toBe("run /code-review");
		// The two halves of the carve-out, visible together: the resolver
		// still finds the reference — Edit mode decorates it and it counts —
		// only Preview refuses to link inside a multi-word code span.
		expect(findRefs(text, ["code-review"])).toHaveLength(1);
	});

	it("keeps bold markup intact around a reference (C1)", () => {
		const skillRefs = makeSkillRefs(["grill"], null, []);
		const root = renderMd("Load the **/grill** skill first.", skillRefs);
		const strong = root.querySelector("strong");
		expect(strong).toBeTruthy();
		const ref = strong!.querySelector(".md-skill-ref");
		expect(ref).toBeTruthy();
		expect(ref!.textContent).toBe("/grill");
	});

	it("keeps a markdown link intact around a reference, and does not link the reference inside it (a button cannot nest inside an anchor)", () => {
		const skillRefs = makeSkillRefs(["grill"], null, []);
		const root = renderMd("See [/grill](https://example.com/g) for details.", skillRefs);
		const link = root.querySelector("a.md-link") as HTMLAnchorElement;
		expect(link).toBeTruthy();
		expect(link.getAttribute("href")).toBe("https://example.com/g");
		expect(link.textContent).toBe("/grill");
		expect(link.querySelector(".md-skill-ref")).toBeNull();
	});

	it("resolves a backtick reference nested inside emphasis markup", () => {
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd("*emphasis with `code-review`*", skillRefs);
		const em = root.querySelector("em");
		expect(em).toBeTruthy();
		const ref = em!.querySelector(".md-skill-ref");
		expect(ref).toBeTruthy();
		expect(ref!.textContent).toBe("code-review");
	});

	it("does not link a reference inside a fenced code block", () => {
		const text = "```\nsee /code-review\n```";
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd(text, skillRefs);
		expect(root.querySelector(".md-skill-ref")).toBeNull();
		const pre = root.querySelector("pre > code");
		expect(pre).toBeTruthy();
		expect(pre!.textContent).toBe("see /code-review");
	});

	it("agrees with the corpus on how many links Preview shows", () => {
		for (const c of CORPUS.cases) {
			const skillRefs = makeSkillRefs(c.names, c.self, c.ignore);
			const root = renderMd(c.text, skillRefs);
			const count = root.querySelectorAll(".md-skill-ref").length;
			expect(count, c.name).toBe(c.preview_hits);
			cleanup();
		}
	});

	it("leaves a path-like slash and a link target alone", () => {
		const names = ["plan", "plan-file"];
		for (const text of [
			"see references/plan-file.md",
			"./plan",
			"[x](/plan)",
		]) {
			const skillRefs = makeSkillRefs(names, null, []);
			const root = renderMd(text, skillRefs);
			expect(root.querySelector(".md-skill-ref"), text).toBeNull();
			cleanup();
		}
	});

	it("changes nothing when skillRefs is absent", () => {
		const md = "see `code-review` and also /code-review here.";
		const withoutOption = renderMd(md);
		const withEmptyOptions = render(<>{renderMarkdown(md, {})}</>).container.querySelector(
			".md-prose",
		) as HTMLElement;
		expect(withEmptyOptions.outerHTML).toBe(withoutOption.outerHTML);
		expect(withoutOption.querySelector(".md-skill-ref")).toBeNull();
	});

	it("shows the hover card after the open delay", () => {
		vi.useFakeTimers();
		const skillRefs = makeSkillRefs(["code-review"], null, []);
		const root = renderMd("see `code-review`", skillRefs);
		const link = root.querySelector("button.md-skill-ref") as HTMLButtonElement;
		act(() => {
			fireEvent.mouseEnter(link);
		});
		act(() => {
			vi.advanceTimersByTime(249);
		});
		expect(root.querySelector(".skill-ref-card")).toBeNull();
		act(() => {
			vi.advanceTimersByTime(2);
		});
		const card = root.querySelector(".skill-ref-card");
		expect(card).toBeTruthy();
		expect(card!.querySelector(".skill-ref-card-desc")!.textContent).toBe(
			DESCRIPTIONS["code-review"],
		);
		const nameButton = card!.querySelector(
			"button.skill-ref-card-name",
		) as HTMLButtonElement;
		expect(nameButton).toBeTruthy();
		expect(nameButton.textContent).toBe("code-review");
	});
});
