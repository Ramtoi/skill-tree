// ─── Skill cross-reference resolver (TypeScript twin) ────────────────────────
// A reference is a SKILL.md body mention of a registered skill name, either as
// an exact backtick span (`deliver-it`, form: "backtick") or as a slash token
// (/deliver-it, form: "slash"). Bare slugs in prose are never references,
// frontmatter is never scanned, and a name inside a fenced code block still
// counts. The exact regex sources and every boundary rule are pinned in
// plans/INTERFACES.md and mirrored, verbatim, by the Python twin
// `skill_refs.py`. Pure module: no React, no IPC, no `@/types` value import.

// ---------------------------------------------------------------------------
// The matching rule — copied verbatim from plans/INTERFACES.md. Nothing else
// decides a hit. Only lookaheads and a leading alternation group are used (no
// lookbehind — old WebKit throws on module load), and character classes are
// ASCII-explicit (never `\w` — Python's is Unicode-aware, JS's is not).
// ---------------------------------------------------------------------------

export const BACKTICK_SPAN_SRC = "`([^`\\n]+)`";

// Split into three named parts for the slash-reference completion source
// (wave 3) to recompose the open condition without re-typing the grammar.
// `SLASH_REF_SRC` below is byte-identical to the single literal this used to
// be — a vitest assertion pins that identity so the recomposition can never
// drift from the Python twin.
/** The character required immediately before the `/` (or line start). */
export const SLASH_REF_LEAD_CLASS = "[^A-Za-z0-9_/.~(]";
/** The slug shape: lowercase-ascii start, then lowercase-ascii or `-`. */
export const SLASH_REF_NAME_SRC = "[a-z0-9][a-z0-9-]*";
/** The three trailing guards: not a word char, not `/`, not `.<word>`. */
export const SLASH_REF_TAIL_SRC = "(?![A-Za-z0-9_-])(?!/)(?!\\.[A-Za-z0-9_])";
export const SLASH_REF_SRC =
  `(^|${SLASH_REF_LEAD_CLASS})/(${SLASH_REF_NAME_SRC})` + SLASH_REF_TAIL_SRC;

export type SkillRefForm = "backtick" | "slash";

export interface SkillRefHit {
  name: string;
  form: SkillRefForm;
  offset: number;
  length: number;
}

export interface SkillRefEdgeCount {
  name: string;
  count: number;
}

export interface SkillRefRenderOptions {
  names: readonly string[];
  self?: string;
  ignore?: readonly string[];
  describe: (name: string) => string | undefined;
  onOpen: (name: string) => void;
}

/** Split `text` into `[frontmatter, body]`.
 *
 * A straight port of the Rust `split_frontmatter`
 * (`app/src-tauri/src/commands/registry.rs:130-160`) / the Python twin
 * `skill_refs.py::split_frontmatter`. Strips every leading BOM; the closing
 * fence must use the same line-ending style as the opening one; the body has
 * every leading repetition of that line ending removed. An unterminated (or
 * absent, or empty) frontmatter fence means the whole file is body — the
 * caller never treats that as an error. The returned frontmatter EXCLUDES the
 * eol that starts the closer.
 */
export function splitFrontmatter(text: string): [string | null, string] {
  let stripped = text;
  while (stripped.startsWith("﻿")) {
    stripped = stripped.slice(1);
  }

  let afterOpen: string;
  let eol: string;
  if (stripped.startsWith("---\r\n")) {
    afterOpen = stripped.slice("---\r\n".length);
    eol = "\r\n";
  } else if (stripped.startsWith("---\n")) {
    afterOpen = stripped.slice("---\n".length);
    eol = "\n";
  } else {
    return [null, stripped];
  }

  const closer = `${eol}---${eol}`;
  const idx = afterOpen.indexOf(closer);
  if (idx === -1) {
    return [null, stripped];
  }

  const frontmatter = afterOpen.slice(0, idx);
  let body = afterOpen.slice(idx + closer.length);
  while (body.startsWith(eol)) {
    body = body.slice(eol.length);
  }
  return [frontmatter, body];
}

// ASCII-explicit — matches the Python twin's `_TOKEN_WS` exactly, avoiding
// the locale-dependent divergence between Python's `str.isspace()` (includes
// NEL/U+0085) and JS's `\s` (includes U+FEFF, which Python's excludes).
const TOKEN_WS_RE = /[ \t\n\r\f\v]/;

/** True when `content` (a backtick span's content) has no whitespace. */
function isSingleToken(content: string): boolean {
  return !TOKEN_WS_RE.test(content);
}

/** Every reference to a registered skill name inside `text`'s body.
 *
 * Returns hits sorted by `(offset, name)`. `selfName` and every entry of
 * `ignore` are removed from the target set before scanning. Offsets are
 * indices into the FULL original `text` (frontmatter, if any, is skipped
 * over). Pure: no I/O. Same ordering, same filtering, same offsets as the
 * Python twin `skill_refs.py::find_refs`.
 */
export function findRefs(
  text: string,
  names: Iterable<string>,
  selfName?: string | null,
  ignore: Iterable<string> = [],
): SkillRefHit[] {
  const targetNames = new Set(names);
  if (selfName != null) {
    targetNames.delete(selfName);
  }
  for (const name of ignore) {
    targetNames.delete(name);
  }

  const [, body] = splitFrontmatter(text);
  const base = text.length - body.length;

  const hits: SkillRefHit[] = [];
  const consumedSpans: Array<[number, number, string]> = [];

  const backtickRe = new RegExp(BACKTICK_SPAN_SRC, "gm");
  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(body)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const content = match[1];
    consumedSpans.push([start, end, content]);
    if (targetNames.has(content)) {
      hits.push({
        name: content,
        form: "backtick",
        offset: base + start,
        length: end - start,
      });
    }
    if (match[0].length === 0) {
      backtickRe.lastIndex += 1;
    }
  }

  const slashRe = new RegExp(SLASH_REF_SRC, "gm");
  while ((match = slashRe.exec(body)) !== null) {
    const name = match[2];
    if (!targetNames.has(name)) {
      if (match[0].length === 0) {
        slashRe.lastIndex += 1;
      }
      continue;
    }
    // match.index is where the leading alternation group starts; the slash
    // itself sits after group 1 (which may be empty at the start of text).
    const slashPos = match.index + match[1].length;

    let enclosing: [number, number] | null = null;
    for (const [spanStart, spanEnd, spanContent] of consumedSpans) {
      if (spanStart <= slashPos && slashPos < spanEnd && isSingleToken(spanContent)) {
        enclosing = [spanStart, spanEnd];
        break;
      }
    }

    if (enclosing !== null) {
      const [spanStart, spanEnd] = enclosing;
      hits.push({
        name,
        form: "slash",
        offset: base + spanStart,
        length: spanEnd - spanStart,
      });
    } else {
      hits.push({
        name,
        form: "slash",
        offset: base + slashPos,
        length: 1 + name.length,
      });
    }

    if (match[0].length === 0) {
      slashRe.lastIndex += 1;
    }
  }

  hits.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return hits;
}

/** Hit count per target name; a name with zero hits is absent. */
export function countRefs(
  text: string,
  names: Iterable<string>,
  selfName?: string | null,
  ignore: Iterable<string> = [],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const hit of findRefs(text, names, selfName, ignore)) {
    counts[hit.name] = (counts[hit.name] ?? 0) + 1;
  }
  return counts;
}

/** Incoming references to `target` across a corpus of SKILL.md bodies.
 *
 * For every corpus key except `target`, counts references from that body to
 * `target` (applying that referrer's own ignore list, when `ignoreOf` is
 * given). Rows with a count > 0, sorted by name. TS-only — the Python
 * equivalent is a `build_graph` filter.
 */
export function incomingRefs(
  corpus: Record<string, string>,
  target: string,
  names: Iterable<string>,
  ignoreOf?: (referrer: string) => Iterable<string>,
): SkillRefEdgeCount[] {
  const rows: SkillRefEdgeCount[] = [];
  for (const referrer of Object.keys(corpus)) {
    if (referrer === target) continue;
    const body = corpus[referrer];
    const ignore = ignoreOf ? ignoreOf(referrer) : [];
    const counts = countRefs(body, names, referrer, ignore);
    const count = counts[target] ?? 0;
    if (count > 0) {
      rows.push({ name: referrer, count });
    }
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

/** `findRefs` minus every hit that lies inside an inline backtick span.
 *
 * The single encoding of Preview's inline-code carve-out (the fenced-block
 * half needs no code here — a fenced block never reaches the inline
 * renderer, so it is handled by the block renderer itself). Any backtick
 * span (single-token or multi-word) swallows the hits inside it, because
 * Preview turns that whole span into a `<code>` element.
 */
export function previewHits(
  text: string,
  names: Iterable<string>,
  selfName?: string | null,
  ignore: Iterable<string> = [],
): SkillRefHit[] {
  const hits = findRefs(text, names, selfName, ignore);
  const [, body] = splitFrontmatter(text);
  const base = text.length - body.length;

  const spans: Array<[number, number]> = [];
  const backtickRe = new RegExp(BACKTICK_SPAN_SRC, "gm");
  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(body)) !== null) {
    const start = base + match.index;
    const end = start + match[0].length;
    spans.push([start, end]);
    if (match[0].length === 0) {
      backtickRe.lastIndex += 1;
    }
  }

  // A backtick-form hit's range always coincides exactly with the backtick
  // span that produced it (its content resolved to a target name) — that
  // span becomes the code element itself, which Preview renders as a ref
  // button, so it is never dropped here. Only a slash-form hit that falls
  // inside a (single-token or multi-word) backtick span is a carve-out: that
  // span renders as plain inline code, so the slash token inside it stays
  // unlinked.
  return hits.filter((hit) => {
    if (hit.form === "backtick") return true;
    return !spans.some(([start, end]) => start <= hit.offset && hit.offset < end);
  });
}

export interface SlashRefContext {
  /** Offset of the `/` in `text`. */
  from: number;
  /** Offset just past the typed name (the caret). */
  to: number;
  /** The typed name, without the slash. `""` when only `/` has been typed. */
  query: string;
}

// Non-global, so `.exec`/`.test` never carry state across calls. Anchored to
// the END of the tested string ("$"), since the caller always tests the
// prefix from line-start up to the caret — the same line-anchored lead-class
// rule `findRefs` applies via its own "m" flag. The name group is wrapped
// `(?:...)?` — OPTIONAL — unlike `findRefs`'s own (which requires >=1 char):
// a bare `/` (nothing typed yet) is a valid, reportable position (`query`
// becomes `""`); `findRefs` never has to represent that in-progress state, so
// its `SLASH_REF_NAME_SRC` alone is correctly stricter.
const SLASH_OPEN_RE = new RegExp(
  `(?:^|${SLASH_REF_LEAD_CLASS})/((?:${SLASH_REF_NAME_SRC})?)$`,
);
const SLASH_TAIL_RE = new RegExp(`^(?:${SLASH_REF_TAIL_SRC})`);

/** Where `pos` sits inside a slash token that WOULD parse as a reference.
 *
 * `null` when a `/name` written at `pos` could never be one: inside
 * frontmatter, or where the slash is part of a path (`references/x`, `./x`,
 * `../x`, `~/x`, `(/x`, `a/x`), or where the name runs into `/`, `.ext`, or a
 * word character. The single encoding of the completion's open condition,
 * derived from the same regex sources `findRefs` uses — never re-typed.
 *
 * `query` may be `""` (a bare `/`): this helper reports the grammar
 * honestly. The POLICY that a bare `/` does not open the completion overlay
 * lives in `skillRefCompletionSource` (components/skillRefs/refCompletion.ts),
 * not here — that split keeps this helper reusable on its own.
 */
export function slashRefContextAt(text: string, pos: number): SlashRefContext | null {
  const [, body] = splitFrontmatter(text);
  const base = text.length - body.length;
  if (pos < base) return null; // frontmatter is never scanned

  // The line containing `pos`, clamped to `base` — the line search must never
  // walk back into frontmatter (or the blank lines `splitFrontmatter` strips
  // between the closing fence and the first real line of the body).
  const lineStart = Math.max(base, text.lastIndexOf("\n", pos - 1) + 1);
  const prefix = text.slice(lineStart, pos);

  const openMatch = SLASH_OPEN_RE.exec(prefix);
  if (!openMatch) return null;

  const query = openMatch[1];
  const from = pos - query.length - 1; // one char back from the name: the "/"

  // The trailing guards look ahead at most two characters (`.` + a word
  // char); end-of-line/end-of-doc satisfies every guard trivially.
  if (!SLASH_TAIL_RE.test(text.slice(pos, pos + 2))) return null;

  return { from, to: pos, query };
}
