import type { ImportMergedCandidate } from "@/types/permissions";

export type ImportTriageKind = "general" | "specific";

export interface ImportTriage {
  kind: ImportTriageKind;
  reason: string | null;
}

const EXACT_TEST_TARGET =
  /(?:^|\s)--tests?(?:[=\s]|$)|\b(?:pytest|vitest|jest)\b[^)]*(?:::|(?:\s|=)-k\b|--testNamePattern\b)|\bpytest\b[^)]*\s+\S*(?:test_[^/\s)]+\.py|[^/\s)]+_test\.py)(?::\*)?(?:\s|$)|\b(?:vitest(?:\s+run)?|jest)\b[^)]*\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?(?::\*)?(?:\s|$)/i;
const MACHINE_PATH =
  /(?:^|[\s('"=])(?:\/(?:Users|home|private|tmp|var\/folders)\/|[A-Za-z]:\\)/;

function patternBody(pattern: string): string {
  const open = pattern.indexOf("(");
  return open >= 0 && pattern.endsWith(")")
    ? pattern.slice(open + 1, -1)
    : pattern;
}

/**
 * A conservative UI hint, not a policy decision. It separates concise,
 * reusable patterns from rules that look tied to one approval or machine.
 */
export function importCandidateTriage(
  candidate: ImportMergedCandidate,
): ImportTriage {
  if (
    candidate.sources.some(
      (source) =>
        source.source.endsWith("settings.local.json") ||
        source.file?.endsWith("settings.local.json"),
    )
  ) {
    return {
      kind: "specific",
      reason: "Found in a project-local settings file.",
    };
  }

  const body = patternBody(candidate.pattern);
  if (EXACT_TEST_TARGET.test(body)) {
    return { kind: "specific", reason: "Names an exact test target." };
  }
  if (MACHINE_PATH.test(body)) {
    return { kind: "specific", reason: "Contains a machine-specific path." };
  }

  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (body.length >= 96 || words >= 10) {
    return {
      kind: "specific",
      reason: "Pins a long command with many arguments.",
    };
  }

  return { kind: "general", reason: null };
}

export function partitionImportCandidates(rows: ImportMergedCandidate[]): {
  general: ImportMergedCandidate[];
  specific: ImportMergedCandidate[];
} {
  const general: ImportMergedCandidate[] = [];
  const specific: ImportMergedCandidate[] = [];
  for (const row of rows) {
    (importCandidateTriage(row).kind === "specific" ? specific : general).push(
      row,
    );
  }
  return { general, specific };
}
