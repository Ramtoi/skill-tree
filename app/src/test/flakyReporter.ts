// Vitest 3.2 reporter (see `Reporter` in vitest/dist/chunks/reporters.d.*.d.ts):
// records every test that needed a retry to pass, for `testing/scripts/
// flaky_report.py` to cross-check against `testing/flaky.yaml`.
//
// Wired only under GitHub Actions (app/vitest.config.ts's `reporters`
// array); local runs never produce this file. `TestCase.diagnostic()` is
// only populated after the run finishes, and its `flaky` field is exactly
// "passed on a retry" (vitest sets `flaky` only when `retryCount > 0` and
// the final result passed) — verified against node_modules/vitest's
// shipped `.d.ts` before relying on it here, since the vitest JSON reporter
// itself carries no retry information.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

interface FlakyEntry {
  file: string;
  title: string;
  retries: number;
}

interface FlakyReport {
  runner: "vitest";
  flaky: FlakyEntry[];
}

const OUTPUT_PATH = resolve(__dirname, "../../vitest-report/flaky.json");
const REPO_ROOT = resolve(__dirname, "../../..");

export default class FlakyReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const flaky: FlakyEntry[] = [];
    for (const testModule of testModules) {
      const file = toRepoRelative(testModule.moduleId);
      for (const testCase of testModule.children.allTests()) {
        const diagnostic = testCase.diagnostic();
        if (diagnostic?.flaky) {
          flaky.push({ file, title: testCase.fullName, retries: diagnostic.retryCount });
        }
      }
    }
    const report: FlakyReport = { runner: "vitest", flaky };
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  }
}

function toRepoRelative(moduleId: string): string {
  const rel = relative(REPO_ROOT, moduleId);
  // Windows never runs this reporter (GHA-only, and CI's vitest job is
  // Linux), but keep the separator repo-relative-id form used everywhere
  // else in testing/flaky.yaml (forward slashes).
  return rel.split("\\").join("/");
}
