import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── UI-layer query-key guard ──────────────────────────────────────────────
//
// `lib/queryKeys.ts` is the ONE file allowed to hold a `queryKey: [...]`
// literal. Every `useQuery`/`useMutation`/`invalidateQueries` call under
// `components/` and `screens/` (plus `App.tsx`) must read its key from the
// `qk` registry instead. This is the exact complement of
// `test/queryKeyGuard.data.test.ts` (which covers `lib/` and `hooks/`) — the
// two together cover every product module under `src/`. Modelled on
// `test/ipcImportGuard.test.ts` / `test/hubCmdGuard.test.ts`.

const SRC = join(process.cwd(), "src");

/** Dirs exempt from this guard because a different guard (or none) owns them:
 *  `lib/` and `hooks/` are covered by `queryKeyGuard.data.test.ts`; `test/`
 *  and `mocks/` are test scaffolding, not product code. */
const ALLOW_DIRS = [
  "lib" + sep,
  "hooks" + sep,
  "test" + sep,
  "mocks" + sep,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function isAllowed(relPath: string): boolean {
  return ALLOW_DIRS.some((d) => relPath.startsWith(d));
}

const QUERY_KEY_LITERAL = /queryKey:\s*\[/;

describe("query-key guard (UI layer)", () => {
  it("no module outside lib/ or hooks/ holds a queryKey: [...] literal", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (isAllowed(rel)) continue;
      if (QUERY_KEY_LITERAL.test(readFileSync(file, "utf-8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
