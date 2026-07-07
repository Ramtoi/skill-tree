// ─── Golden fixtures for renderMarkdown (D3) ──────────────────────────────────
// Each fixture drives renderMarkdown.test.tsx, asserting rendered structure
// (tag / text / attrs) over a DOM root. The previously-lossy cases are explicit
// regression rows (ordered-list numbers, H2 casing, italics/links/blockquotes).
// `check` uses DOM APIs only (jsdom) — no test framework imports here.

const FENCE = "```";

export interface MarkdownFixture {
	name: string;
	md: string;
	/** Assert the rendered `.md-prose` root; throw on any mismatch. */
	check: (root: HTMLElement) => void;
}

function must(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

export const MD_FIXTURES: MarkdownFixture[] = [
	{
		name: "headings-1-6",
		md: "# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F",
		check: (r) => {
			for (const [tag, text] of [
				["h1", "A"],
				["h2", "B"],
				["h3", "C"],
				["h4", "D"],
				["h5", "E"],
				["h6", "F"],
			] as const) {
				const el = r.querySelector(tag);
				must(!!el, `expected <${tag}>`);
				must(el!.textContent === text, `<${tag}> text = ${el!.textContent}`);
			}
			// Regression: h3–h6 are real headings, not paragraphs.
			must(r.querySelectorAll("p").length === 0, "no stray <p> for headings");
		},
	},
	{
		name: "h2-no-uppercase",
		md: "## Setup",
		check: (r) => {
			const h2 = r.querySelector("h2");
			must(!!h2, "expected <h2>");
			// Regression: exact casing preserved (no text-transform in markup).
			must(h2!.textContent === "Setup", `h2 text = ${h2!.textContent}`);
		},
	},
	{
		name: "ordered-numbers",
		md: "1. a\n2. b\n3. c",
		check: (r) => {
			const ol = r.querySelector("ol");
			must(!!ol, "expected <ol>");
			must(!r.querySelector("ul"), "regression: must not be a <ul>");
			must(ol!.querySelectorAll("li").length === 3, "expected 3 <li>");
		},
	},
	{
		name: "ordered-start",
		md: "3. a\n4. b",
		check: (r) => {
			const ol = r.querySelector("ol");
			must(!!ol, "expected <ol>");
			must(ol!.getAttribute("start") === "3", `start = ${ol!.getAttribute("start")}`);
		},
	},
	{
		name: "nested-list",
		md: "- a\n  - b",
		check: (r) => {
			const topUl = r.querySelector("ul");
			must(!!topUl, "expected top <ul>");
			const nested = topUl!.querySelector("li > ul");
			must(!!nested, "expected one nested <ul>");
			must(
				nested!.querySelectorAll("li").length === 1,
				"nested list has one item",
			);
		},
	},
	{
		name: "unordered",
		md: "- a\n* b",
		check: (r) => {
			const uls = r.querySelectorAll("ul");
			must(uls.length === 1, `expected one <ul>, got ${uls.length}`);
			must(uls[0].querySelectorAll("li").length === 2, "both markers → 2 <li>");
		},
	},
	{
		name: "italic",
		md: "*hi* _yo_",
		check: (r) => {
			const ems = r.querySelectorAll("em");
			// Regression: was literal asterisks/underscores.
			must(ems.length === 2, `expected 2 <em>, got ${ems.length}`);
			must(ems[0].textContent === "hi", `em[0] = ${ems[0].textContent}`);
			must(ems[1].textContent === "yo", `em[1] = ${ems[1].textContent}`);
		},
	},
	{
		name: "bold",
		md: "**x** __y__",
		check: (r) => {
			const strongs = r.querySelectorAll("strong");
			must(strongs.length === 2, `expected 2 <strong>, got ${strongs.length}`);
		},
	},
	{
		name: "bold-vs-italic",
		md: "**a** *b*",
		check: (r) => {
			const strong = r.querySelector("strong");
			const em = r.querySelector("em");
			must(!!strong && strong.textContent === "a", "strong a");
			must(!!em && em.textContent === "b", "em b");
		},
	},
	{
		name: "inline-code",
		md: "a `b` c",
		check: (r) => {
			const code = r.querySelector("code.md-code-inline");
			must(!!code, "expected inline <code>");
			must(code!.textContent === "b", `code = ${code!.textContent}`);
			must(/a/.test(r.textContent ?? ""), "surrounding text present");
		},
	},
	{
		name: "link",
		md: "[t](https://x)",
		check: (r) => {
			const a = r.querySelector("a.md-link");
			must(!!a, "expected <a.md-link>");
			must(a!.textContent === "t", `a text = ${a!.textContent}`);
			must(
				a!.getAttribute("title") === "https://x",
				`title = ${a!.getAttribute("title")}`,
			);
		},
	},
	{
		name: "link-nonhttp",
		md: "[t](javascript:x)",
		check: (r) => {
			// Scheme guard: no anchor, plain styled text.
			must(!r.querySelector("a"), "regression: no <a> for non-web scheme");
			const plain = r.querySelector(".md-link-plain");
			must(!!plain && plain.textContent === "t", "plain label text");
		},
	},
	{
		name: "blockquote",
		md: "> q1\n> q2",
		check: (r) => {
			const bq = r.querySelector("blockquote");
			must(!!bq, "regression: expected <blockquote>");
			const t = bq!.textContent ?? "";
			must(t.includes("q1") && t.includes("q2"), `bq text = ${t}`);
		},
	},
	{
		name: "fenced-code",
		md: `${FENCE}\nx\n${FENCE}`,
		check: (r) => {
			const pre = r.querySelector("pre");
			must(!!pre, "expected <pre>");
			const code = pre!.querySelector("code");
			must(!!code && code.textContent === "x", `code = ${code?.textContent}`);
		},
	},
	{
		name: "fenced-code-no-inline",
		md: `${FENCE}\n**not bold**\n${FENCE}`,
		check: (r) => {
			must(!r.querySelector("strong"), "no inline markdown inside a fence");
			const code = r.querySelector("pre code");
			must(
				code!.textContent === "**not bold**",
				`raw code = ${code?.textContent}`,
			);
		},
	},
	{
		name: "hr",
		md: "para\n\n---\n\nmore",
		check: (r) => {
			must(!!r.querySelector("hr"), "expected <hr>");
			// Not confused with a heading/paragraph.
			must(r.querySelectorAll("p").length === 2, "two paragraphs around the hr");
		},
	},
	{
		name: "paragraph",
		md: "a\nb",
		check: (r) => {
			const ps = r.querySelectorAll("p");
			must(ps.length === 1, `one <p>, got ${ps.length}`);
			must(ps[0].textContent === "a b", `joined text = ${ps[0].textContent}`);
		},
	},
	{
		name: "mixed-doc",
		md: [
			"# Skill",
			"",
			"A short **intro** with a [link](https://example.com).",
			"",
			"## Steps",
			"",
			"1. first",
			"2. second",
			"",
			"> note this",
			"",
			`${FENCE}bash`,
			"echo hi",
			`${FENCE}`,
		].join("\n"),
		check: (r) => {
			must(!!r.querySelector("h1"), "h1");
			must(!!r.querySelector("h2"), "h2");
			must(!!r.querySelector("ol"), "ol");
			must(!!r.querySelector("blockquote"), "blockquote");
			must(!!r.querySelector("pre code"), "code block");
			must(!!r.querySelector("a.md-link"), "link");
			must(!!r.querySelector("strong"), "bold");
		},
	},
];
