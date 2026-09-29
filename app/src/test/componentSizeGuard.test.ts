import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── God-component guard ───────────────────────────────────────────────────
//
// ESLint is configured (see eslint.config.js) but has no line-count or
// useState-count rule for this codebase, so this guard is the enforcement
// for both. This guard keeps S6's "no god components" invariant from regressing: no .tsx file
// under src/ may exceed MAX_LINES, and no component function may declare
// more than MAX_USESTATE `useState` calls. It also pins the ProjectWorkspace
// dialog-hoist fix (each project dialog rendered exactly once, not once per
// tab branch).

const SRC = join(process.cwd(), "src");
const MAX_LINES = 1000;
const MAX_USESTATE = 12;

// .tsx files over MAX_LINES that predate this guard and are out of the S6
// scope. A ratchet, not a blanket exemption: each entry's ceiling is its
// line count on the day it was seeded (below), so the file may still shrink
// freely but any further growth reds this guard. Once a file drops back
// under MAX_LINES the "no stale ratchet entries" case below fails until the
// entry is deleted, so a fixed file can't linger here unnoticed.
const RATCHET: Record<string, number> = {
  [join("components", "remotes", "RemoteDetail.tsx")]: 1229, // seeded 2026-09-18
  [join("screens", "SkillLibrary.tsx")]: 1901, // seeded 2026-09-18 — bundle mode composes screens/library/BundleLens.tsx
};

// Component functions over MAX_USESTATE, out of the S6 scope.
const LEGACY_COMPONENTS = ["AddRemoteWizard", "SkillEditor", "AddSourceModal"];

// Components S6 has not yet decomposed. All four S6 entries are done:
// slice 2 decomposed "PermissionsEditor" + "HookEditor" (hooks/usePermissionsDraft.ts,
// hooks/useHookDraft.ts, components/permissions + components/hooks), and slice 3
// decomposed "SubagentEditor" + "AgentDocsView" (hooks/useSubagentDraft.ts,
// hooks/useAgentDocBuffers.ts, components/subagents + components/agentDocs).
// A PR must have a green suite, so any future entries here are excluded from BOTH the
// line-count check (via PENDING_FILES) and the useState check (by name)
// until their slice lands — but the staleness assertion below fails loudly
// if an entry stops actually needing the exemption, so a fixed file can't
// linger in the list unnoticed.
const PENDING: string[] = [];

// One file per PENDING entry. Sources.tsx and ProjectWorkspace.tsx (slice 1,
// already decomposed) are deliberately NOT here.
const PENDING_FILES: Record<string, string> = {
};

const DECL = /^(?:export\s+)?(?:default\s+)?(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*[:=])/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

const SKIP_DIRS = ["test" + sep, "mocks" + sep];

function isSkipped(relPath: string): boolean {
  return SKIP_DIRS.some((d) => relPath.startsWith(d));
}

const FILES = walk(SRC)
  .map((p) => relative(SRC, p))
  .filter((rel) => !isSkipped(rel));

function lineCount(rel: string): number {
  return readFileSync(join(SRC, rel), "utf-8").split("\n").length;
}

/** Max `useState` count across every top-level declaration in `rel` whose
 *  name is not itself exempted — i.e. the worst offender the file would
 *  report to assertion 2, or 0 if the file declares no such component. */
function maxUseStateInFile(rel: string): number {
  const content = readFileSync(join(SRC, rel), "utf-8");
  const re = new RegExp(DECL.source, "gm");
  const matches: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const name = m[1] ?? m[2];
    if (name) matches.push({ name, index: m.index });
  }
  let max = 0;
  for (let i = 0; i < matches.length; i++) {
    const { index } = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const segment = content.slice(index, end);
    const count = (segment.match(/useState[(<]/g) ?? []).length;
    if (count > max) max = count;
  }
  return max;
}

describe("component size guard", () => {
  it("no .tsx file exceeds 1000 lines, or its own ratcheted ceiling", () => {
    const pendingFiles = new Set(Object.values(PENDING_FILES));
    const offenders: string[] = [];
    for (const rel of FILES) {
      if (pendingFiles.has(rel)) continue;
      const lines = lineCount(rel);
      const ceiling = RATCHET[rel] ?? MAX_LINES;
      if (lines > ceiling) offenders.push(`${rel} (${lines} > ${ceiling})`);
    }
    expect(offenders).toEqual([]);
  });

  it("no ratchet entry is stale (file already back under the general cap)", () => {
    const stale: string[] = [];
    for (const [rel, ceiling] of Object.entries(RATCHET)) {
      const lines = lineCount(rel);
      if (lines <= MAX_LINES) {
        stale.push(`${rel}: ${lines} lines (ceiling ${ceiling}) — delete this RATCHET entry`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("no component declares more than 12 useState", () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const content = readFileSync(join(SRC, rel), "utf-8");
      const re = new RegExp(DECL.source, "gm");
      const matches: { name: string; index: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const name = m[1] ?? m[2];
        if (name) matches.push({ name, index: m.index });
      }
      for (let i = 0; i < matches.length; i++) {
        const { name, index } = matches[i];
        if (LEGACY_COMPONENTS.includes(name) || PENDING.includes(name)) continue;
        const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
        const segment = content.slice(index, end);
        const count = (segment.match(/useState[(<]/g) ?? []).length;
        if (count > MAX_USESTATE) offenders.push(`${rel}:${name} (${count})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ProjectWorkspace renders each project dialog exactly once", () => {
    const src = readFileSync(join(SRC, "screens", "ProjectWorkspace.tsx"), "utf-8");
    expect((src.match(/<EditProjectPathDialog/g) ?? []).length).toBe(1);
    expect((src.match(/<RemoveProjectDialog/g) ?? []).length).toBe(1);
  });

  it("every PENDING entry still actually needs its exemption", () => {
    // Once a slice fixes a component (line count back under the cap AND
    // useState back at/under it), its PENDING entry is dead weight — remove
    // both the name from PENDING and its line from PENDING_FILES.
    const stale: string[] = [];
    for (const name of PENDING) {
      const rel = PENDING_FILES[name];
      if (!rel) {
        stale.push(`${name} — no PENDING_FILES entry`);
        continue;
      }
      const lines = lineCount(rel);
      const useState = maxUseStateInFile(rel);
      if (lines <= MAX_LINES && useState <= MAX_USESTATE) {
        stale.push(`${name} (${rel}): ${lines} lines, ${useState} useState — no longer over either cap`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("PENDING and PENDING_FILES stay in lockstep", () => {
    expect(Object.keys(PENDING_FILES).sort()).toEqual([...PENDING].sort());
  });
});
