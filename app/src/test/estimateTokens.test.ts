import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  estimateTokensFromBytes,
  formatTokens,
} from "@/lib/estimateTokens";

describe("formatTokens", () => {
  it("renders sub-thousand counts as bare integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders sub-10K counts with one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2400)).toBe("2.4K");
    expect(formatTokens(9999)).toBe("10.0K");
  });

  it("renders larger counts as rounded integer K", () => {
    expect(formatTokens(10000)).toBe("10K");
    expect(formatTokens(48100)).toBe("48K");
    expect(formatTokens(123456)).toBe("123K");
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns a small positive integer for short prose", () => {
    const n = estimateTokens("hello world");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
    expect(Number.isInteger(n)).toBe(true);
  });

  it("scales monotonically with content length", () => {
    const short = estimateTokens("The quick brown fox.");
    const long = estimateTokens(
      "The quick brown fox jumps over the lazy dog. ".repeat(20),
    );
    expect(long).toBeGreaterThan(short);
  });
});

describe("estimateTokensFromBytes", () => {
  it("returns 0 for zero or negative input", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(-100)).toBe(0);
  });

  it("divides by 4 with rounding", () => {
    expect(estimateTokensFromBytes(4000)).toBe(1000);
    expect(estimateTokensFromBytes(16000)).toBe(4000);
    expect(estimateTokensFromBytes(1)).toBe(0);
    expect(estimateTokensFromBytes(2)).toBe(1);
    expect(estimateTokensFromBytes(3)).toBe(1);
  });

  it("returns integers", () => {
    expect(Number.isInteger(estimateTokensFromBytes(5_000))).toBe(true);
    expect(Number.isInteger(estimateTokensFromBytes(12_345))).toBe(true);
  });
});
