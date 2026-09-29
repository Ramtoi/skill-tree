import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	previewHits,
	splitFrontmatter,
	type SkillRefForm,
	type SkillRefHit,
	type SkillRefRenderOptions,
} from "@/lib/skillRefs";
import { SkillRefCard } from "@/components/skillRefs/SkillRefCard";

// ─── Pure markdown → ReactNode renderer (D1) ──────────────────────────────────
// Two-pass, in-house, dependency-light. Block pass line-scans into a block list;
// inline pass tokenizes text runs. React-node output only — never
// dangerouslySetInnerHTML (no sanitizer surface). Styling is classes-only under
// `.md-prose` (App.css) — zero inline styles.
//
// Documented tipping point → adopt `marked`/`react-markdown` when any of these
// become requirements: markdown tables, task-list checkboxes, nested lists
// deeper than one level, reference-style links, raw-HTML passthrough.

export interface RenderMarkdownOptions {
	/** How a link is activated. Default: openUrl(href) via @tauri-apps/plugin-opener. */
	onOpenLink?: (href: string) => void;
	/** Turns a resolvable backtick/slash skill mention into a clickable
	 *  `.md-skill-ref` link with a hover card. Absent by default — no
	 *  reference pre-pass runs and the render is byte-identical to before
	 *  this option existed (golden-fixture pinned). When set, a leading
	 *  frontmatter fence is stripped before block-parsing (matching the
	 *  resolver's own body-only rule) so a frontmatter-only mention is never
	 *  rendered or linked. */
	skillRefs?: SkillRefRenderOptions;
}

// ─── Block model ──────────────────────────────────────────────────────────────
interface ListItem {
	content: string;
	children?: ListBlock;
}
interface ListBlock {
	ordered: boolean;
	start: number;
	items: ListItem[];
}
type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "blockquote"; lines: string[] }
	| { type: "list"; list: ListBlock }
	| { type: "code"; lang: string; lines: string[] }
	| { type: "hr" }
	| { type: "p"; lines: string[] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^```/;
const QUOTE_RE = /^\s*>\s?/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)\.\s+(.*)$/;

interface ItemMatch {
	indent: number;
	ordered: boolean;
	num: number;
	text: string;
}

function matchItem(line: string): ItemMatch | null {
	const ol = OL_RE.exec(line);
	if (ol) {
		return {
			indent: ol[1].length,
			ordered: true,
			num: Number.parseInt(ol[2], 10),
			text: ol[3],
		};
	}
	const ul = UL_RE.exec(line);
	if (ul) {
		return { indent: ul[1].length, ordered: false, num: 0, text: ul[2] };
	}
	return null;
}

function isBlockStart(line: string): boolean {
	return (
		HEADING_RE.test(line) ||
		FENCE_RE.test(line.trim()) ||
		HR_RE.test(line.trim()) ||
		QUOTE_RE.test(line) ||
		matchItem(line) !== null
	);
}

/** Parse a contiguous list run starting at `i`; returns the block + next index.
    Supports one level of nesting via leading indent (≥2 spaces). */
function parseList(lines: string[], i: number): { list: ListBlock; next: number } {
	const first = matchItem(lines[i])!;
	const ordered = first.ordered;
	const list: ListBlock = { ordered, start: first.num, items: [] };
	let cur: ListItem | null = null;
	while (i < lines.length) {
		const it = matchItem(lines[i]);
		if (!it) break;
		if (it.indent >= 2 && cur) {
			// One level of nesting — attach to the previous base-level item.
			if (!cur.children) {
				cur.children = { ordered: it.ordered, start: it.num, items: [] };
			}
			cur.children.items.push({ content: it.text });
		} else {
			// Base level: a change of ordered-ness starts a *new* list.
			if (cur && it.ordered !== ordered) break;
			cur = { content: it.text };
			list.items.push(cur);
		}
		i++;
	}
	return { list, next: i };
}

function parseBlocks(md: string): Block[] {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		// Fenced code — raw, no inline markdown inside.
		if (FENCE_RE.test(trimmed)) {
			const lang = trimmed.slice(3).trim();
			const code: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
				code.push(lines[i]);
				i++;
			}
			i++; // consume closing fence (if any)
			blocks.push({ type: "code", lang, lines: code });
			continue;
		}

		// Blank lines separate blocks.
		if (trimmed === "") {
			i++;
			continue;
		}

		// Heading (#..######).
		const h = HEADING_RE.exec(line);
		if (h) {
			blocks.push({ type: "heading", level: h[1].length, text: h[2] });
			i++;
			continue;
		}

		// Horizontal rule — a lone --- / *** / ___ at a block boundary (blank
		// line already consumed above, and we never fall through a paragraph
		// into here, so this is never a setext underline / frontmatter fence).
		if (HR_RE.test(trimmed)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}

		// Blockquote — may span consecutive `>` lines.
		if (QUOTE_RE.test(line)) {
			const qlines: string[] = [];
			while (i < lines.length && QUOTE_RE.test(lines[i])) {
				qlines.push(lines[i].replace(QUOTE_RE, ""));
				i++;
			}
			blocks.push({ type: "blockquote", lines: qlines });
			continue;
		}

		// List (ul/ol) with one level of nesting.
		if (matchItem(line)) {
			const { list, next } = parseList(lines, i);
			blocks.push({ type: "list", list });
			i = next;
			continue;
		}

		// Paragraph — gather until a blank line or the next block start.
		const plines: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!isBlockStart(lines[i])
		) {
			plines.push(lines[i]);
			i++;
		}
		blocks.push({ type: "p", lines: plines });
	}
	return blocks;
}

// ─── Inline pass ──────────────────────────────────────────────────────────────
const WEB_SCHEME_RE = /^(?:https?:|mailto:)/i;

interface InlineRule {
	re: RegExp;
	render: (
		m: RegExpExecArray,
		key: number,
		opts: RenderMarkdownOptions,
	) => ReactNode;
}

// Order encodes the tie-break: on an equal start index, the first rule wins
// (so `**` beats `*`, `__` beats `_`). Each regex is anchored-free; we scan for
// the earliest match across all rules (longest-left-match generalized). Rules
// that the skill-ref pre-pass needs to recognize by identity (see
// `renderInlinePlain`) are named consts — still the same six rules, same
// order, no new entry.
const STRONG_STAR_RULE: InlineRule = {
	re: /\*\*([^*]+)\*\*/,
	render: (m, key) => <strong key={key}>{m[1]}</strong>,
};
const STRONG_UNDERSCORE_RULE: InlineRule = {
	re: /__([^_]+)__/,
	render: (m, key) => <strong key={key}>{m[1]}</strong>,
};
const INLINE_CODE_RULE: InlineRule = {
	re: /`([^`]+)`/,
	render: (m, key) => (
		<code key={key} className="md-code-inline">
			{m[1]}
		</code>
	),
};
// A reference inside a link's label deliberately never becomes a
// `.md-skill-ref` button: the button is a `<button>`, and nesting one inside
// an `<a>` is invalid HTML (and un-clickable in practice). Link wins — the
// label renders as plain text, same as before the skill-ref pre-pass existed.
const LINK_RULE: InlineRule = {
	re: /\[([^\]]*)\]\(([^)]+)\)/,
	render: (m, key, opts) => {
		const label = m[1];
		const href = m[2].trim();
		if (!WEB_SCHEME_RE.test(href)) {
			// Non-web scheme → plain styled text, no anchor, no open.
			return (
				<span key={key} className="md-link-plain">
					{label}
				</span>
			);
		}
		return (
			<a
				key={key}
				className="md-link"
				href={href}
				title={href}
				onClick={(e) => {
					e.preventDefault();
					(opts.onOpenLink ?? ((h: string) => void openUrl(h)))(href);
				}}
			>
				{label}
			</a>
		);
	},
};
const EM_STAR_RULE: InlineRule = {
	re: /\*([^*]+)\*/,
	render: (m, key) => <em key={key}>{m[1]}</em>,
};
const EM_UNDERSCORE_RULE: InlineRule = {
	re: /_([^_]+)_/,
	render: (m, key) => <em key={key}>{m[1]}</em>,
};

const INLINE_RULES: InlineRule[] = [
	STRONG_STAR_RULE,
	STRONG_UNDERSCORE_RULE,
	INLINE_CODE_RULE,
	LINK_RULE,
	EM_STAR_RULE,
	EM_UNDERSCORE_RULE,
];

/** Live state for the skill-ref pre-pass, threaded through `renderInlinePlain`
 *  instead of splicing the raw fragment up front (grill C1 — a top-level
 *  splice cut `**`/`[…](…)` markup in half whenever a hit landed inside it).
 *  `hits` and their offsets are always relative to the ORIGINAL string handed
 *  to `renderInline`; `base` is where the text currently being scanned starts
 *  within that original string. */
interface RefCtx {
	refs: SkillRefRenderOptions;
	hits: SkillRefHit[];
	base: number;
}

/** Splits a run of literal characters this render owns outright — a
 *  top-level leaf between rule matches, or the label `**bold**`/`*em*`
 *  captured — at every `previewHits` hit that fits entirely inside it,
 *  rendering each as a `.md-skill-ref` link and leaving the rest as plain
 *  text. `base` is `text`'s offset within the original string `previewHits`
 *  ran over. Never called for a `[link](href)` label — see `LINK_RULE`. */
function applyRefsToLeaf(
	text: string,
	base: number,
	ctx: RefCtx,
	keyOffset: number,
): ReactNode[] {
	const local = ctx.hits.filter(
		(h) => h.offset >= base && h.offset + h.length <= base + text.length,
	);
	if (local.length === 0) return [text];
	const out: ReactNode[] = [];
	let pos = 0;
	local.forEach((hit, i) => {
		const start = hit.offset - base;
		const end = start + hit.length;
		if (start > pos) out.push(text.slice(pos, start));
		const label = hit.form === "backtick" ? hit.name : text.slice(start, end);
		out.push(
			<PreviewRefLink
				key={`ref-${keyOffset + i}-${hit.offset}`}
				name={hit.name}
				label={label}
				form={hit.form}
				refs={ctx.refs}
			/>,
		);
		pos = end;
	});
	if (pos < text.length) out.push(text.slice(pos));
	return out;
}

/** The original rule-scanner. `keyOffset` lets a caller splice several calls
 *  into one sibling array without colliding React keys. `ctx`, when given,
 *  runs the skill-ref pre-pass over every literal leaf this function emits
 *  (see `applyRefsToLeaf`) — including `**bold**`/`*em*`'s captured content,
 *  re-entered on its own capture group so a reference inside markup still
 *  resolves without a new `INLINE_RULES` entry — and swaps the inline-code
 *  rule's match for a ref link when it coincides exactly with a
 *  backtick-form hit. With `ctx` absent (no `skillRefs` option) this is
 *  byte-identical to the pre-C1 scanner. */
function renderInlinePlain(
	s: string,
	opts: RenderMarkdownOptions,
	keyOffset = 0,
	ctx?: RefCtx,
): ReactNode[] {
	const out: ReactNode[] = [];
	let rest = s;
	let key = keyOffset;
	let pos = ctx ? ctx.base : 0;
	while (rest.length) {
		let best: { rule: InlineRule; m: RegExpExecArray } | null = null;
		for (const candidate of INLINE_RULES) {
			const m = candidate.re.exec(rest);
			if (!m) continue;
			if (best === null || m.index < best.m.index) {
				best = { rule: candidate, m };
			}
		}
		if (!best) {
			out.push(...(ctx ? applyRefsToLeaf(rest, pos, ctx, key) : [rest]));
			break;
		}
		const { rule, m } = best;
		if (m.index > 0) {
			const lead = rest.slice(0, m.index);
			out.push(...(ctx ? applyRefsToLeaf(lead, pos, ctx, key) : [lead]));
		}

		const matchStart = pos + m.index;
		let node: ReactNode | undefined;
		if (ctx && rule === INLINE_CODE_RULE) {
			const hit = ctx.hits.find(
				(h) =>
					h.form === "backtick" &&
					h.offset === matchStart &&
					h.length === m[0].length,
			);
			if (hit) {
				node = (
					<PreviewRefLink
						key={key}
						name={hit.name}
						label={hit.name}
						form="backtick"
						refs={ctx.refs}
					/>
				);
			}
		} else if (
			ctx &&
			(rule === STRONG_STAR_RULE ||
				rule === STRONG_UNDERSCORE_RULE ||
				rule === EM_STAR_RULE ||
				rule === EM_UNDERSCORE_RULE)
		) {
			const isStrong = rule === STRONG_STAR_RULE || rule === STRONG_UNDERSCORE_RULE;
			const delimLen = isStrong ? 2 : 1;
			const children = applyRefsToLeaf(m[1], matchStart + delimLen, ctx, key);
			node = createElement(isStrong ? "strong" : "em", { key }, children);
		}
		out.push(node ?? rule.render(m, key, opts));

		key++;
		pos = matchStart + m[0].length;
		rest = rest.slice(m.index + m[0].length);
	}
	return out;
}

/** Hover-managed `.md-skill-ref` link — the Preview host for the shared
 *  `SkillRefCard`. A 250ms open delay and a 120ms close grace (moving the
 *  pointer from the button onto the card must not dismiss it). */
export function PreviewRefLink({
	name,
	label,
	form,
	refs,
}: {
	name: string;
	label: string;
	form: SkillRefForm;
	refs: SkillRefRenderOptions;
}) {
	const [open, setOpen] = useState(false);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (openTimer.current) clearTimeout(openTimer.current);
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	const handleEnter = () => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		if (open || openTimer.current) return;
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setOpen(true);
		}, 250);
	};
	const handleLeave = () => {
		if (openTimer.current) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
		if (closeTimer.current) return;
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setOpen(false);
		}, 120);
	};

	return (
		<span className="md-skill-ref-anchor">
			<button
				type="button"
				className="md-skill-ref"
				data-ref={name}
				data-form={form}
				onMouseEnter={handleEnter}
				onMouseLeave={handleLeave}
				onClick={() => refs.onOpen(name)}
			>
				{label}
			</button>
			{open && (
				<span
					className="md-skill-ref-popover"
					onMouseEnter={handleEnter}
					onMouseLeave={handleLeave}
				>
					<SkillRefCard
						name={name}
						description={refs.describe(name)}
						onOpen={() => refs.onOpen(name)}
					/>
				</span>
			)}
		</span>
	);
}

/** The one Preview carve-out (plans/INTERFACES.md § "The one Preview
 *  carve-out"): a reference inside a fenced block never reaches this
 *  function at all (the block renderer emits its lines raw), and one inside
 *  a multi-word or single-token inline code span is excluded by
 *  `previewHits` itself. `opts.skillRefs` absent runs no pre-pass at all, so
 *  the render is byte-identical to before this option existed — no new
 *  `INLINE_RULES` entry, no `^` alternation. The pre-pass itself runs inside
 *  `renderInlinePlain` (see `RefCtx`), not here — splicing the raw fragment
 *  at hit boundaries up front used to cut `**`/`[…](…)` markup in half
 *  whenever a hit landed inside it (grill C1). */
function renderInline(s: string, opts: RenderMarkdownOptions): ReactNode[] {
	const refs = opts.skillRefs;
	if (!refs) return renderInlinePlain(s, opts);

	const hits = previewHits(s, refs.names, refs.self, refs.ignore);
	if (hits.length === 0) return renderInlinePlain(s, opts);

	return renderInlinePlain(s, opts, 0, { refs, hits, base: 0 });
}

// ─── Block rendering ──────────────────────────────────────────────────────────
function renderList(list: ListBlock, opts: RenderMarkdownOptions, keyBase: string): ReactNode {
	const items = list.items.map((it, j) => (
		<li key={`${keyBase}-${j}`}>
			{renderInline(it.content, opts)}
			{it.children && renderList(it.children, opts, `${keyBase}-${j}n`)}
		</li>
	));
	if (list.ordered) {
		return createElement(
			"ol",
			{ start: list.start !== 1 ? list.start : undefined },
			items,
		);
	}
	return <ul>{items}</ul>;
}

function renderBlock(b: Block, i: number, opts: RenderMarkdownOptions): ReactNode {
	switch (b.type) {
		case "heading":
			return createElement(`h${b.level}`, { key: i }, renderInline(b.text, opts));
		case "blockquote":
			return (
				<blockquote key={i}>
					{renderInline(b.lines.join(" "), opts)}
				</blockquote>
			);
		case "list":
			return <div key={i}>{renderList(b.list, opts, `l${i}`)}</div>;
		case "code":
			return (
				<pre key={i}>
					<code>{b.lines.join("\n")}</code>
				</pre>
			);
		case "hr":
			return <hr key={i} />;
		case "p":
			return <p key={i}>{renderInline(b.lines.join(" "), opts)}</p>;
	}
}

/** Pure two-pass markdown renderer. Returns a `.md-prose` root of React nodes. */
export function renderMarkdown(md: string, opts: RenderMarkdownOptions = {}): ReactNode {
	// The block parser has no frontmatter concept of its own — gated behind
	// `skillRefs` so an option-free render stays byte-identical (golden
	// fixtures never carry a leading `---` fence). With it set, stripping the
	// fence up front matches the resolver's body-only rule exactly, so a
	// frontmatter-only mention is dropped instead of rendering as a stray
	// paragraph AND registering a false-positive `.md-skill-ref`.
	const source = opts.skillRefs ? splitFrontmatter(md)[1] : md;
	const blocks = parseBlocks(source);
	return (
		<div className="md-prose">
			{blocks.map((b, i) => renderBlock(b, i, opts))}
		</div>
	);
}
