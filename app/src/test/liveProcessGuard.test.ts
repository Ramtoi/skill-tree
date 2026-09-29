import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ─── Live-process feedback guard ─────────────────────────────────────────────
//
// Two rules, both learned from real defects on this codebase:
//
//  1. ONE BUSY AFFORDANCE. A control that fires a live process (a subprocess, a
//     network round-trip, a disk walk) must report itself with `busy` /
//     `loading` — the shared spinner + disable + `aria-busy` grammar. Not a
//     bare `disabled`, not a hand-written `{x ? "Syncing…" : "Sync"}` label.
//     The project header's Sync button had NEITHER: clicking it changed nothing
//     on screen, so the obvious move was to click it again — and the second
//     `hub sync` lost the backend `.lock` and reported a failure for a run that
//     had actually succeeded.
//
//  2. ONE SYNC. `hub sync` had three implementations, so the identical command
//     rendered as a process card from the Library and as a bare toast from the
//     status bar. Every caller goes through `useRunSync`.
//
// This is a source guard rather than a render test on purpose: it holds for
// controls no test file happens to mount, and it fails on the NEXT one somebody
// adds.

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC)
  .map((f) => relative(SRC, f))
  .filter((rel) => !rel.startsWith("test" + sep) && !rel.startsWith("mocks" + sep));

const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

/**
 * Handlers whose name says "this spawns a live process". Deliberately a
 * name-based heuristic over the onClick expression: it catches the shape a new
 * screen actually writes (`onClick={() => void runSync()}`) without needing to
 * understand the call graph.
 */
const LIVE_HANDLER =
  /\b(runSync|doRescan|forceSync|onSync(?!c)|onCheckSource|exportAndOpen|runBackupNow|installUpdate|fetchHostKey|runCopyId|createAndCheck|onApply|adopt|refreshEverywhere|onUpdateEverywhere)\b/;

/** Slice out one JSX opening tag, brace-aware so nested `{...}` don't end it. */
function openTag(src: string, from: number): string {
  let i = from;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
    i++;
  }
  return src.slice(from, i);
}

interface Offender {
  file: string;
  line: number;
  tag: string;
}

function scanForMissingBusy(): Offender[] {
  const offenders: Offender[] = [];
  for (const rel of FILES) {
    const src = read(rel);
    for (const m of src.matchAll(/<(LoadingButton|Button)\b/g)) {
      const tag = openTag(src, m.index!);
      if (/\bbusy=|\bloading=/.test(tag)) continue;
      const onClick = /onClick=\{([\s\S]{0,200})/.exec(tag);
      if (!onClick || !LIVE_HANDLER.test(onClick[1])) continue;
      offenders.push({
        file: rel,
        line: src.slice(0, m.index!).split("\n").length,
        tag: tag.split(/\s+/).join(" ").slice(0, 120),
      });
    }
  }
  return offenders;
}

describe("live-process feedback guard", () => {
  it("every control that fires a live process carries the shared busy state", () => {
    // Reported as `file:line` so a failure names the button, not just a count.
    expect(scanForMissingBusy().map((o) => `${o.file}:${o.line} — ${o.tag}`)).toEqual([]);
  });

  it("`hub sync` has exactly one implementation", () => {
    // Anything else spawning `["sync"]` is a second sync flow with its own
    // feedback — the defect this replaced.
    const rogue = FILES.filter(
      (rel) => rel !== join("hooks", "useRunSync.ts") && /runHubCmd\(\s*\[\s*"sync"/.test(read(rel)),
    );
    expect(rogue).toEqual([]);
  });

  it("`useRunSync` reports through the shared process banner", () => {
    const src = read(join("hooks", "useRunSync.ts"));
    expect(src).toMatch(/trackProcess\(/);
    expect(src).toMatch(/export function useSyncing/);
  });

  it("the named long-running actions all open a process card", () => {
    // sync / update / backup — the three the coherence pass was cut against,
    // plus the remote push, which is the longest of the lot.
    const wired: Array<[string, string]> = [
      ["hooks/useRunSync.ts", "sync"],
      ["hooks/useUpdate.ts", "update"],
      ["hooks/useBackup.ts", "backup"],
      ["screens/RemotesScreen.tsx", "remote sync"],
    ];
    const missing = wired
      .filter(([f]) => !/trackProcess|Processes\.start/.test(read(f.split("/").join(sep))))
      .map(([, label]) => label);
    expect(missing).toEqual([]);
  });
});
