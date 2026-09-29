import { estimateTokensFromBytes } from "@/lib/estimateTokens";
import type { SearchCorpus } from "@/lib/unifiedSearch";

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function utf8Bytes(value: string): number {
  return encoder ? encoder.encode(value).length : value.length;
}

/** Estimates every available skill body from the already-loaded search corpus. */
export function estimateSkillBodies(corpus: SearchCorpus | undefined): Record<string, number> {
  if (!corpus) return {};
  return Object.fromEntries(
    Object.entries(corpus.skills)
      .filter(([, body]) => typeof body === "string")
      .map(([name, body]) => [name, estimateTokensFromBytes(utf8Bytes(body))]),
  );
}
