import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Slice B (S7) split the former monolithic `src/App.css` into 29 anchored
 * files under `src/styles/` (see `src/styles/index.css`, §3.4 of
 * `_orchestration/plans/S7-css-scales-split.md`). A handful of pre-existing
 * tests assert against the raw stylesheet SOURCE text (jsdom does not apply
 * real CSS, so behavioral rules like "the active row gets a left ring" are
 * pinned by reading the rule text itself).
 *
 * This helper reproduces the exact string those tests used to get from
 * `readFileSync("src/App.css")`: it reads `src/styles/index.css`, walks its
 * `@import` lines in order, and concatenates every imported file **except**
 * `reset-preflight.css` and `command-layer.css` — the two files that were
 * never part of `App.css`'s own text (the former was only ever `@import`ed
 * *by* App.css, never inlined into it; the latter was always a sibling file
 * loaded separately by `main.tsx`). The result is byte-for-byte the same
 * content the old `src/App.css` held, just reassembled from its split files.
 */
export function readAppCss(): string {
  const stylesDir = resolve(process.cwd(), "src/styles");
  const indexPath = resolve(stylesDir, "index.css");
  const indexCss = readFileSync(indexPath, "utf8");

  const importRe = /@import\s+["']([^"']+)["'];/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(indexCss)) !== null) {
    const rel = match[1];
    // styleguide.css styles the dev-only /styleguide iteration surface — it was
    // never part of App.css and shouldn't count against the app's CSS guards.
    if (
      rel.endsWith("reset-preflight.css") ||
      rel.endsWith("command-layer.css") ||
      rel.endsWith("styleguide.css")
    )
      continue;
    const filePath = resolve(dirname(indexPath), rel);
    parts.push(readFileSync(filePath, "utf8"));
  }
  return parts.join("");
}
