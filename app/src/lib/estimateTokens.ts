import { encode } from "gpt-tokenizer/model/gpt-5";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

export function estimateTokensFromBytes(bytes: number): number {
  if (!bytes || bytes < 0) return 0;
  return Math.round(bytes / 4);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}
