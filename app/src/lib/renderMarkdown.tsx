import { createElement, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

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
// the earliest match across all rules (longest-left-match generalized).
const INLINE_RULES: InlineRule[] = [
	{
		re: /\*\*([^*]+)\*\*/,
		render: (m, key) => <strong key={key}>{m[1]}</strong>,
	},
	{
		re: /__([^_]+)__/,
		render: (m, key) => <strong key={key}>{m[1]}</strong>,
	},
	{
		re: /`([^`]+)`/,
		render: (m, key) => (
			<code key={key} className="md-code-inline">
				{m[1]}
			</code>
		),
	},
	{
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
	},
	{
		re: /\*([^*]+)\*/,
		render: (m, key) => <em key={key}>{m[1]}</em>,
	},
	{
		re: /_([^_]+)_/,
		render: (m, key) => <em key={key}>{m[1]}</em>,
	},
];

function renderInline(s: string, opts: RenderMarkdownOptions): ReactNode[] {
	const out: ReactNode[] = [];
	let rest = s;
	let key = 0;
	while (rest.length) {
		let best: { rule: InlineRule; m: RegExpExecArray } | null = null;
		for (const rule of INLINE_RULES) {
			const m = rule.re.exec(rest);
			if (!m) continue;
			if (best === null || m.index < best.m.index) {
				best = { rule, m };
			}
		}
		if (!best) {
			out.push(rest);
			break;
		}
		if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
		out.push(best.rule.render(best.m, key++, opts));
		rest = rest.slice(best.m.index + best.m[0].length);
	}
	return out;
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
	const blocks = parseBlocks(md);
	return (
		<div className="md-prose">
			{blocks.map((b, i) => renderBlock(b, i, opts))}
		</div>
	);
}
