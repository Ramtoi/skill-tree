import { describe, expect, it } from "vitest";
import {
  importCandidateTriage,
  partitionImportCandidates,
} from "@/lib/permissionImportTriage";
import type { ImportMergedCandidate } from "@/types/permissions";

function candidate(
  pattern: string,
  source = "default.rules",
): ImportMergedCandidate {
  return {
    pattern,
    kind: "allow",
    harnesses: null,
    sources: [{ harness: "codex", source }],
  };
}

describe("permission import triage", () => {
  it("keeps concise wildcard commands in the general group", () => {
    expect(
      importCandidateTriage(candidate("Bash(./gradlew :domain:test:*)")),
    ).toEqual({ kind: "general", reason: null });
  });

  it("marks project-local approvals as specific", () => {
    expect(
      importCandidateTriage(
        candidate("Bash(terraform plan:*)", "settings.local.json"),
      ),
    ).toEqual({
      kind: "specific",
      reason: "Found in a project-local settings file.",
    });
  });

  it.each([
    [
      "Bash(./gradlew test --tests com.example.RepositoryTest:*)",
      "Names an exact test target.",
    ],
    [
      "Read(/Users/dev/private-project/secrets.json)",
      "Contains a machine-specific path.",
    ],
    [
      "Bash(tool alpha beta gamma delta epsilon zeta eta theta iota:*)",
      "Pins a long command with many arguments.",
    ],
  ])("marks %s as specific", (pattern, reason) => {
    expect(importCandidateTriage(candidate(pattern))).toEqual({
      kind: "specific",
      reason,
    });
  });

  it.each([
    "Bash(pytest tests/test_cli.py:*)",
    "Bash(vitest run src/foo.test.ts:*)",
    "Bash(jest src/foo.test.ts:*)",
  ])("marks the file-targeted test run %s as specific", (pattern) => {
    expect(importCandidateTriage(candidate(pattern))).toEqual({
      kind: "specific",
      reason: "Names an exact test target.",
    });
  });

  it.each(["Bash(pytest:*)", "Bash(vitest:*)", "Bash(jest:*)"])(
    "keeps the bare test runner %s general",
    (pattern) => {
      expect(importCandidateTriage(candidate(pattern))).toEqual({
        kind: "general",
        reason: null,
      });
    },
  );

  it("partitions rows without changing their order", () => {
    const rows = [
      candidate("Bash(cargo:*)"),
      candidate("Bash(pytest tests/unit/test_cli.py::test_sync:*)"),
      candidate("Bash(npm:*)"),
    ];
    const result = partitionImportCandidates(rows);
    expect(result.general.map((row) => row.pattern)).toEqual([
      "Bash(cargo:*)",
      "Bash(npm:*)",
    ]);
    expect(result.specific.map((row) => row.pattern)).toEqual([
      "Bash(pytest tests/unit/test_cli.py::test_sync:*)",
    ]);
  });
});
