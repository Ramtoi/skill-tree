import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── Clickable non-interactive element guard ──────────────────────────────
//
// The app has no ESLint setup yet ("eslint . " arrives alongside this test in
// S9 slice A). Until then — and forever after as a belt-and-suspenders CI
// gate — this re-implements the intent of `jsx-a11y/click-events-have-key-events`
// + `jsx-a11y/no-static-element-interactions` as a source scan: every
// non-interactive JSX element that carries an `onClick` attribute must be
// EITHER a documented presentational sink (role="presentation"/"none",
// aria-hidden, the named `stopEvent` handler) OR a fully-wired interactive
// widget (role + tabIndex + a key handler, or a composite `aria-selected`
// child), OR carry the `/* a11y-ok: ... */` escape-hatch comment.
//
// Scanning is brace/quote-balanced (not a line regex) because most of these
// tags span multiple lines — a naive `^\s*<div` regex misses the majority.

const SRC = join(process.cwd(), "src");

const NONINTERACTIVE_TAGS = new Set([
  "div", "span", "li", "tr", "td", "th", "p", "section", "article", "header",
  "footer", "nav", "ul", "ol", "table", "tbody", "thead", "label",
  "h1", "h2", "h3", "h4", "h5", "h6", "main", "aside", "figure", "pre",
  "code", "form", "a",
]);

const TAG_OPEN_RE = new RegExp(
  `<(${[...NONINTERACTIVE_TAGS].join("|")})(?=[\\s/>])`,
  "g",
);

/** Find the index of the `>` that closes the opening tag started at `start`
 *  (index right after the tag name), skipping over quoted strings and
 *  brace-delimited JS expressions so a `>` used inside an attribute
 *  expression (comparisons, generics, nested JSX) is never mistaken for the
 *  tag terminator. */
function findTagEnd(text: string, start: number): number {
  let i = start;
  let depth = 0;
  let inString: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      i++;
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === ">" && depth === 0) return i;
    i++;
  }
  return -1;
}

const ONCLICK_RE = /(?<![\w-])onClick=/;
const HREF_RE = /(?<![\w-])href=/;

function isCompliant(attrText: string): boolean {
  if (/aria-hidden=["']true["']/.test(attrText)) return true;
  if (/role=["'](presentation|none)["']/.test(attrText)) return true;
  if (/onClick=\{stopEvent\}/.test(attrText)) return true;
  if (/aria-selected/.test(attrText)) return true;
  if (
    /(?<![\w-])role=/.test(attrText) &&
    /(?<![\w-])tabIndex/.test(attrText) &&
    /(onKeyDown|onKeyUp|onKeyPress)=/.test(attrText)
  ) {
    return true;
  }
  if (attrText.includes("/* a11y-ok:")) return true;
  return false;
}

function extractClassName(attrText: string): string | undefined {
  const idx = attrText.search(/(?<![\w-])className=/);
  if (idx === -1) return undefined;
  const after = idx + "className=".length;
  const c = attrText[after];
  if (c === '"' || c === "'") {
    const end = attrText.indexOf(c, after + 1);
    return end === -1 ? undefined : attrText.slice(after + 1, end);
  }
  if (c === "{") {
    // Walk to the matching '}' (findTagEnd looks for '>', not '}', so it can't be reused here).
    let i = after + 1;
    let depth = 1;
    let inString: string | null = null;
    while (i < attrText.length && depth > 0) {
      const ch = attrText[i];
      if (inString) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        i++;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      i++;
    }
    const exprText = attrText.slice(after + 1, i - 1);
    const tmplMatch = exprText.match(/^`([^`$]*)/); // e.g. `bundle-chip ${x}` -> "bundle-chip "
    if (tmplMatch && tmplMatch[1].trim()) return tmplMatch[1].trim();
    const strMatch = exprText.match(/["'`]([^"'`]+)["'`]/);
    return strMatch ? strMatch[1] : exprText.trim().slice(0, 40) || undefined;
  }
  return undefined;
}

interface Offender {
  relPath: string;
  tag: string;
  className: string | undefined;
}

function key(o: Offender): string {
  return `${o.relPath}:${o.tag}:${o.className ?? "-"}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

function isExcluded(relPath: string): boolean {
  return relPath.startsWith("test" + sep) || relPath.startsWith("mocks" + sep);
}

function scanFile(relPath: string, content: string): Offender[] {
  const offenders: Offender[] = [];
  let m: RegExpExecArray | null;
  TAG_OPEN_RE.lastIndex = 0;
  while ((m = TAG_OPEN_RE.exec(content))) {
    const tag = m[1];
    const attrStart = TAG_OPEN_RE.lastIndex;
    const tagEnd = findTagEnd(content, attrStart);
    if (tagEnd === -1) continue;
    const attrText = content.slice(attrStart, tagEnd);
    TAG_OPEN_RE.lastIndex = tagEnd; // resume scanning after this tag

    if (tag === "a" && HREF_RE.test(attrText)) continue; // real link, out of scope
    if (!ONCLICK_RE.test(attrText)) continue; // not clickable, not our concern

    if (isCompliant(attrText)) continue;

    offenders.push({ relPath, tag, className: extractClassName(attrText) });
  }
  return offenders;
}

const allOffenders: Offender[] = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (isExcluded(rel)) continue;
  allOffenders.push(...scanFile(rel, readFileSync(file, "utf-8")));
}

// ─── Known offenders (the a11y backlog) ────────────────────────────────────
// Populated by the S9 audit scan. Slices B and C convert one site at a time
// and delete its key here; the list is empty once the change is complete.
// `A11Y_STRICT=1` additionally asserts this list itself is empty, so a
// forgotten entry cannot linger silently after the slice that was supposed
// to clear it.
const KNOWN_OFFENDERS: string[] = [];

describe("clickable non-interactive element guard", () => {
  it("has no NEW offenders beyond the known backlog", () => {
    const offenderKeys = allOffenders.map(key);
    const unknown = [...new Set(offenderKeys)].filter((k) => !KNOWN_OFFENDERS.includes(k));
    expect(unknown).toEqual([]);
  });

  if (process.env.A11Y_STRICT) {
    it("[A11Y_STRICT] the offender backlog is fully cleared", () => {
      expect([...new Set(allOffenders.map(key))]).toEqual([]);
      expect(KNOWN_OFFENDERS).toEqual([]);
    });
  }
});
