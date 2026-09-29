import { useEffect, useState } from "react";
import type {
  UsageFootprintHarness,
  UsageFootprintPayload,
} from "@/features/usage/usageAnalyticsTypes";
import { estimateTokens } from "@/lib/estimateTokens";

export interface HarnessFootprintTokens {
  harness: string;
  parts: Array<{ part: string; label: string; tokens: number; bytes: number }>;
  upfront: number;
  total: number;
  discoverable: number;
  discoverableTruncated: boolean;
  bySkill: ReadonlyMap<string, number>;
}

const tokenCache = new Map<string, number>();

export function tokensOf(text: string): number {
  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;
  const value = estimateTokens(text);
  tokenCache.set(text, value);
  if (tokenCache.size > 512) tokenCache.delete(tokenCache.keys().next().value as string);
  return value;
}

export function primaryHarness(payload: UsageFootprintPayload | undefined): string | null {
  if (!payload) return null;
  const keys = Object.keys(payload.harnesses);
  if (keys.includes("claude-code")) return "claude-code";
  return keys.sort()[0] ?? null;
}

export function footprintTokens(
  payload: UsageFootprintPayload | undefined,
  harness: string | null,
): HarnessFootprintTokens | null {
  if (!payload || !harness) return null;
  const block: UsageFootprintHarness | undefined = payload.harnesses[harness];
  if (!block) return null;
  const parts = block.parts.map((part) => ({
    part: part.part,
    label: part.label,
    tokens: tokensOf(part.text),
    bytes: part.bytes,
  }));
  const skillLines = block.skill_lines ?? [];
  const bySkill = new Map(skillLines.map((line) => [line.key, tokensOf(line.text)]));
  return {
    harness,
    parts,
    upfront: parts.find((part) => part.part === "agent_docs")?.tokens ?? 0,
    total: parts.reduce((sum, part) => sum + part.tokens, 0),
    discoverable: (block.discoverable ?? []).reduce((sum, doc) => sum + tokensOf(doc.text), 0),
    discoverableTruncated: block.discoverable_truncated ?? false,
    bySkill,
  };
}

export function useFootprintTokens(
  payload: UsageFootprintPayload | undefined,
  harness: string | null,
): HarnessFootprintTokens | null {
  const values = useFootprintTokensByHarness(payload);
  return harness ? values?.[harness] ?? null : null;
}

export function useFootprintTokensByHarness(
  payload: UsageFootprintPayload | undefined,
): Record<string, HarnessFootprintTokens> | null {
  const [value, setValue] = useState<Record<string, HarnessFootprintTokens> | null>(null);
  const [resolvedPayload, setResolvedPayload] = useState<UsageFootprintPayload | undefined>(undefined);
  useEffect(() => {
    setValue(
      payload
        ? Object.fromEntries(
            Object.keys(payload.harnesses).map((harnessName) => [
              harnessName,
              footprintTokens(payload, harnessName),
            ]),
          ) as Record<string, HarnessFootprintTokens>
        : null,
    );
    setResolvedPayload(payload);
  }, [payload]);
  return resolvedPayload === payload ? value : null;
}
