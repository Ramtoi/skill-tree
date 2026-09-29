import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalHarness, sessionKey } from "@/features/usage/sessionIdentity";

type Corpus = {
  aliases: Array<{ input: string; expect: string | null }>;
  keys: Array<{ harness: string; raw_id: string; expect: string | null }>;
};
const corpus = JSON.parse(
  readFileSync(resolve(process.cwd(), "../tests/fixtures/usage_identity.json"), "utf8"),
) as Corpus;

describe("session identity parity", () => {
  it.each(corpus.aliases)("canonicalizes $input", (testCase) => {
    expect(canonicalHarness(testCase.input)).toBe(testCase.expect ?? undefined);
  });

  it.each(["toString", "constructor", "__proto__"])("rejects inherited alias %s", (value) => {
    expect(canonicalHarness(value)).toBeUndefined();
  });

  it.each(corpus.keys)("constructs a strict key for $harness", (testCase) => {
    expect(sessionKey(testCase.harness, testCase.raw_id)).toBe(testCase.expect ?? undefined);
  });

  it("keeps equal UUIDs separate across harnesses", () => {
    const uuid = "019fd809-2012-7ef2-8cfb-91696cccd6f4";
    expect(sessionKey("claude-code", uuid)).not.toBe(sessionKey("pi", uuid));
  });
});
