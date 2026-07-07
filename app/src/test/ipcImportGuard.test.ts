import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── Restricted-import guard (the `no-restricted-imports` rule, as a test) ────
//
// The app has no ESLint setup (and the plan forbids new dependencies), so the
// "import `invoke` only from `@/lib/ipc`" rule is enforced here instead: every
// module under src/ MUST route Tauri commands through the wrapper in
// `@/lib/ipc` so the global in-flight counter stays accurate. Direct imports of
// `@tauri-apps/api/core` are allowed ONLY in the allowlist below.
//
// If you migrate to ESLint later, port this to:
//   "no-restricted-imports": ["error", { paths: [{ name: "@tauri-apps/api/core",
//     importNames: ["invoke"], message: "Import invoke from @/lib/ipc" }] }]
// with overrides re-permitting it for the same allowlist.

const SRC = join(process.cwd(), "src");

/** Files/dirs permitted to import from `@tauri-apps/api/core` directly. */
const ALLOW = [
  join("lib", "ipc.ts"), // the wrapper itself
  "test" + sep, // test helpers + the setup mock
  "mocks" + sep, // the mocked-Tauri harness
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
  return ALLOW.some((a) => (a.endsWith(sep) ? relPath.startsWith(a) : relPath === a));
}

const CORE_IMPORT = /from\s+["']@tauri-apps\/api\/core["']/;

describe("IPC import guard", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (isAllowed(rel)) continue;
    if (CORE_IMPORT.test(readFileSync(file, "utf-8"))) offenders.push(rel);
  }

  it("no module outside the allowlist imports @tauri-apps/api/core directly", () => {
    expect(offenders).toEqual([]);
  });

  it("the wrapper module exists and re-exports invoke", () => {
    const ipc = readFileSync(join(SRC, "lib", "ipc.ts"), "utf-8");
    expect(ipc).toMatch(CORE_IMPORT);
    expect(ipc).toMatch(/export function invoke/);
  });
});
