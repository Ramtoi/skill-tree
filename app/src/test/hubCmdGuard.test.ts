import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── hub_cmd runner guard ──────────────────────────────────────────────────
//
// `lib/hubCmd.ts` is the ONE place the frontend spawns the Rust `hub_cmd`
// command (via `hubCmd`/`runHubCmd`), and its `HubResult` is the ONE
// declaration of that shape. Every other module reads/writes through it.
// Modelled on `test/ipcImportGuard.test.ts`.

const SRC = join(process.cwd(), "src");

/** Files/dirs permitted to call `invoke("hub_cmd", …)` directly. */
const ALLOW = [
  join("lib", "hubCmd.ts"), // the runner itself
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

const HUB_CMD_INVOKE = /invoke(<[^>]*>)?\(\s*["']hub_cmd["']/;
const HUB_RESULT_DECL = /^\s*(export\s+)?(interface|type)\s+HubResult\b/m;
const HUB_CMD_RESULT_DECL = /\b(interface|type)\s+HubCmdResult\b/;

describe("hub_cmd runner guard", () => {
  const files = walk(SRC);

  it("no module outside lib/hubCmd.ts calls invoke(\"hub_cmd\", …) directly", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (isAllowed(rel)) continue;
      if (HUB_CMD_INVOKE.test(readFileSync(file, "utf-8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("HubResult is declared exactly once, in lib/hubCmd.ts", () => {
    const declaredIn: string[] = [];
    const cmdResultOffenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel.startsWith("test" + sep) || rel.startsWith("mocks" + sep)) continue;
      const content = readFileSync(file, "utf-8");
      if (HUB_RESULT_DECL.test(content)) declaredIn.push(rel);
      if (HUB_CMD_RESULT_DECL.test(content)) cmdResultOffenders.push(rel);
    }
    expect(declaredIn).toEqual([join("lib", "hubCmd.ts")]);
    expect(cmdResultOffenders).toEqual([]);
  });
});
