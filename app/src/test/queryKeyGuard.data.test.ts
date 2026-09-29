import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ─── Query-key literal guard: data layer (src/lib, src/hooks) ────────────────
//
// Every `useQuery`/`useMutation`/`invalidateQueries` call in the data layer
// must read its key from the typed registry at `lib/queryKeys.ts` — no other
// module under `src/lib/**` or `src/hooks/**` may hold a `queryKey: [...]`
// literal. This is G2 from S1-query-keys-runner.md; its complement (the UI
// layer) is enforced by `test/queryKeyGuard.ui.test.ts`.

const SRC = join(process.cwd(), "src");
const DIRS = ["lib", "hooks"];

/** The registry itself is the only file allowed to declare key literals. */
const ALLOW = [join("lib", "queryKeys.ts")];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const QUERY_KEY_LITERAL = /queryKey:\s*\[/;

describe("query-key literal guard (data layer)", () => {
  const offenders: string[] = [];
  for (const dir of DIRS) {
    for (const file of walk(join(SRC, dir))) {
      const rel = relative(SRC, file);
      if (ALLOW.includes(rel)) continue;
      if (QUERY_KEY_LITERAL.test(readFileSync(file, "utf-8"))) offenders.push(rel);
    }
  }

  it("no module under src/lib or src/hooks holds a queryKey literal outside lib/queryKeys.ts", () => {
    expect(offenders).toEqual([]);
  });
});
