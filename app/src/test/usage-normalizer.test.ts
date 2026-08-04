import { describe, expect, it } from "vitest";

import {
  anonymizeProjectPath,
  normalizeCcusageScan,
  readModelBreakdowns,
  readTokens,
  redactPathsInText,
} from "../features/usage/normalizeUsage";
import type { UsageScan } from "../features/usage/usageTypes";

const source = {
  command: "/Applications/Skill Tree.app/Contents/Resources/ccusage",
  args: ["--sections", "daily,weekly,monthly,session", "--by-agent", "--json"],
  resolved_from: "packaged_resource",
};

describe("normalizeCcusageScan", () => {
  it("normalizes ccusage daily/session JSON into Skill Tree-owned types", () => {
    const snapshot = normalizeCcusageScan(sampleScan());

    expect(snapshot.scannedAt).toBe("2026-07-14T22:33:20.000Z");
    expect(snapshot.runner.args).toEqual(source.args);
    expect(snapshot.privacy).toEqual({
      runsLocally: true,
      rawPromptsDisplayed: false,
      fullPathsHiddenByDefault: true,
      costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage.",
    });
    expect(snapshot.overview).toMatchObject({
      totalTokens: 1260,
      sessions: 2,
      topHarness: "Claude Code",
      harnessesDetected: 2,
    });
    expect(snapshot.overview.estimatedCost).toEqual({
      usd: 0.48,
      label: "Estimated API-equivalent cost",
    });
    expect(snapshot.harnesses.slice(0, 2).map((harness) => harness.name)).toEqual([
      "Claude Code",
      "Codex",
    ]);
    expect(snapshot.harnesses.find((harness) => harness.id === "gemini")).toMatchObject({
      name: "Gemini CLI",
      status: "no_usage",
    });
    expect(snapshot.detectedSources.find((source) => source.id === "copilot")).toMatchObject({
      name: "GitHub Copilot CLI",
      status: "no_usage",
    });
    expect(snapshot.daily).toEqual([
      {
        date: "2026-07-14",
        harnesses: [
          {
            id: "claude",
            name: "Claude Code",
            tokens: { input: 300, output: 100, cacheCreation: 20, cacheRead: 80, total: 500 },
            estimatedCost: { usd: 0.2, label: "Estimated API-equivalent cost" },
          },
          {
            id: "codex",
            name: "Codex",
            tokens: { input: 200, output: 60, cacheCreation: 10, cacheRead: 30, total: 300 },
            estimatedCost: { usd: 0.08, label: "Estimated API-equivalent cost" },
          },
        ],
        tokens: { input: 500, output: 160, cacheCreation: 30, cacheRead: 110, total: 800 },
        estimatedCost: { usd: 0.28, label: "Estimated API-equivalent cost" },
      },
    ]);
    expect(snapshot.sessions.map((session) => session.tokens.total)).toEqual([760, 500]);
    // Session ids double as React list keys — every session must have a unique one.
    const ids = snapshot.sessions.map((session) => session.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snapshot.sessions[0]).toMatchObject({
      harnessId: "claude",
      harnessName: "Claude Code",
      project: { label: "Project B", anonymized: true, redactedPath: "…/second-secret" },
      models: ["claude-sonnet-4"],
    });

    // A1 regression guard: harness totals come from the SESSION section only —
    // never double-counted with the independent DAILY section. The fixture's
    // daily and session numbers are deliberately divergent, so a pre-fix
    // double-count resolves to 1260/800/2060 here instead of 760/500/1260.
    expect(snapshot.harnesses.find((h) => h.id === "claude")?.tokens.total).toBe(760);
    expect(snapshot.harnesses.find((h) => h.id === "codex")?.tokens.total).toBe(500);
    expect(
      snapshot.harnesses
        .filter((h) => h.status === "detected")
        .reduce((s, h) => s + h.tokens.total, 0),
    ).toBe(snapshot.overview.totalTokens); // 1260
  });

  it("does not pass prompts, snippets, or full paths through by default", () => {
    const snapshot = normalizeCcusageScan(sampleScan());
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("Please refactor my private code");
    expect(serialized).not.toContain("const privateSecret");
    expect(serialized).not.toContain("/Users/alice/work/secret-project");
    expect(serialized).not.toContain("/Users/alice/work/second-secret");
    expect(serialized).toContain("Project A");
    expect(serialized).toContain("…/secret-project");
  });

  it("can include full paths only when the caller explicitly asks", () => {
    const snapshot = normalizeCcusageScan(sampleScan(), { includeFullPaths: true });

    expect(snapshot.sessions[1].project).toMatchObject({
      label: "Project A",
      fullPath: "/Users/alice/work/secret-project",
    });
  });

  it("gives colliding path-like sessions distinct ids (no duplicate React keys)", () => {
    const path = "/Users/alice/work/secret-project";
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          { agent: "claude", period: path, totalTokens: 100, totalCost: 0.1 },
          { agent: "claude", period: path, totalTokens: 90, totalCost: 0.1 },
        ],
        totals: {},
      },
    });

    expect(snapshot.sessions).toHaveLength(2);
    const [first, second] = snapshot.sessions;
    // Same harness, same path-like period → they resolve to the SAME project…
    expect(first.project?.label).toBe(second.project?.label);
    // …yet must NOT collide as list keys.
    expect(first.id).not.toBe(second.id);
  });

  it("does not surface a path-shaped daily bucket value as a date", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [{ period: "/Users/alice/work/secret-project", totalTokens: 10, totalCost: 0.1 }],
        session: [],
        totals: {},
      },
    });

    expect(snapshot.daily[0].date).toBe("Unknown date");
  });

  it("handles empty or partial ccusage payloads without coupling UI to raw shape", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: { daily: [], weekly: [], monthly: [], session: [], totals: {} },
    });

    expect(snapshot.overview).toMatchObject({
      totalTokens: 0,
      sessions: 0,
      harnessesDetected: 0,
    });
    expect(snapshot.daily).toEqual([]);
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.harnesses.every((harness) => harness.status === "no_usage")).toBe(true);
  });

  it("never double-counts tokens between the daily and session ccusage sections", () => {
    // daily: 2 days totaling 2000 tokens; session: 2 sessions totaling 2000
    // tokens (mirrors real ccusage's invariant that
    // daily-sum === session-sum === totals).
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [
          { period: "2026-07-10", agents: [{ agent: "claude", totalTokens: 1200, totalCost: 12, modelsUsed: ["claude-sonnet-5"] }] },
          { period: "2026-07-11", agents: [{ agent: "claude", totalTokens: 800, totalCost: 8, modelsUsed: ["claude-sonnet-5"] }] },
        ],
        session: [
          { agent: "claude", period: "uuid-1", totalTokens: 1500, totalCost: 15, modelsUsed: ["claude-sonnet-5"] },
          { agent: "claude", period: "uuid-2", totalTokens: 500, totalCost: 5, modelsUsed: ["claude-sonnet-5"] },
        ],
        totals: {},
      },
    });

    const claude = snapshot.harnesses.find((h) => h.id === "claude")!;
    expect(claude.tokens.total).toBe(2000); // NOT 4000
    expect(claude.days).toBe(2);
    expect(claude.sessions).toBe(2);
    expect(
      snapshot.harnesses
        .filter((h) => h.status === "detected")
        .reduce((s, h) => s + h.tokens.total, 0),
    ).toBe(snapshot.overview.totalTokens);
  });

  it("derives harness.days from daily rows only, and harness.tokens/sessions from session rows only", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [
          { period: "2026-07-10", agents: [{ agent: "claude", totalTokens: 999, totalCost: 9, modelsUsed: ["claude-sonnet-5"] }] },
          { period: "2026-07-11", agents: [{ agent: "claude", totalTokens: 999, totalCost: 9, modelsUsed: ["claude-sonnet-5"] }] },
          { period: "2026-07-12", agents: [{ agent: "claude", totalTokens: 999, totalCost: 9, modelsUsed: ["claude-sonnet-5"] }] },
        ],
        session: [
          { agent: "claude", period: "uuid-1", totalTokens: 100, totalCost: 1, modelsUsed: ["claude-sonnet-5"] },
          { agent: "claude", period: "uuid-2", totalTokens: 50, totalCost: 0.5, modelsUsed: ["claude-sonnet-5"] },
        ],
        totals: {},
      },
    });
    const claude = snapshot.harnesses.find((h) => h.id === "claude")!;
    expect(claude.days).toBe(3); // from the 3 distinct daily-row dates
    expect(claude.sessions).toBe(2); // from the 2 session rows
    expect(claude.tokens.total).toBe(150); // 100 + 50 — unaffected by the 3×999 daily totals
  });

  it("sorts a harness's models by usage, not alphabetically", () => {
    // 2 haiku session rows + 1 fable row, breakdowns WITHOUT a totalTokens key
    // (matches real ccusage shape, exercises A2's fallback). Alphabetically
    // "fable" < "haiku"; by usage haiku (1500 summed) must sort first.
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 1300,
            totalCost: 13,
            modelBreakdowns: [
              { modelName: "claude-haiku-...", inputTokens: 900, outputTokens: 400, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 13 },
            ],
          },
          {
            agent: "claude",
            period: "uuid-2",
            totalTokens: 500,
            totalCost: 5,
            modelBreakdowns: [
              { modelName: "claude-haiku-...", inputTokens: 150, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 2 },
              { modelName: "claude-fable-5", inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 3 },
            ],
          },
        ],
        totals: {},
      },
    });
    const claude = snapshot.harnesses.find((h) => h.id === "claude")!;
    expect(claude.models).toEqual(["claude-haiku-...", "claude-fable-5"]);
    expect(
      claude.modelBreakdown.find((m) => m.modelName === "claude-haiku-...")?.tokens.total,
    ).toBe(1500); // summed across both sessions, not overwritten
  });

  it("uses an explicit totalTokens on a breakdown row over the naive component sum in the model breakdown", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 4242,
            totalCost: 42,
            modelBreakdowns: [
              // component sum is 150, but an explicit totalTokens must win
              { modelName: "claude-opus", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 4242, cost: 42 },
            ],
          },
        ],
        totals: {},
      },
    });
    const claude = snapshot.harnesses.find((h) => h.id === "claude")!;
    expect(claude.modelBreakdown.find((m) => m.modelName === "claude-opus")?.tokens.total).toBe(4242);
  });

  it("decodes ccusage's dash-encoded metadata.projectPath into a real project reference", () => {
    const snapshot = normalizeCcusageScan(
      {
        scanned_at: 0,
        source,
        parsed: {
          daily: [],
          weekly: [],
          monthly: [],
          totals: {},
          session: [
            {
              agent: "pi",
              period: "session-uuid-1",
              totalTokens: 100,
              totalCost: 1,
              metadata: { projectPath: "--Users-alice-Dev-private-note-board--" },
            },
          ],
        },
      },
      { includeFullPaths: true },
    );
    const session = snapshot.sessions[0];
    // The real win: an encoded key now RESOLVES to a project (it returned
    // `undefined` before A4).
    expect(session.project).toBeDefined();
    expect(session.project?.anonymized).toBe(true);
    // NOTE: the decoder is intentionally lossy (documented in
    // decodeCcusageProjectKey) — a literal `-` in a real segment ("note-board")
    // is indistinguishable from an encoded `/`, so it decodes to `note/board`.
    // The spec's illustrative "note-board" expectation is unachievable by the
    // spec's own decoder; asserting the decoder's actual output here.
    expect(session.project?.fullPath).toBe("/Users/alice/Dev/private/note/board");
  });
});

describe("usage privacy helpers", () => {
  it("anonymizes project paths deterministically", () => {
    expect(anonymizeProjectPath("/Users/alice/work/skill-tree-private", 0)).toEqual({
      label: "Project A",
      anonymized: true,
      redactedPath: "…/skill-tree-private",
    });
    expect(anonymizeProjectPath("C:\\Users\\Alice\\Projects\\codex", 1)).toEqual({
      label: "Project B",
      anonymized: true,
      redactedPath: "…/codex",
    });
  });

  it("redacts path-shaped substrings inside free-form text", () => {
    expect(
      redactPathsInText("EACCES: cannot read /Users/alice/.claude/logs/a.jsonl now"),
    ).toBe("EACCES: cannot read <redacted-path> now");
    expect(redactPathsInText("open C:\\Users\\Alice\\logs\\x failed")).toContain("<redacted-path>");
    expect(redactPathsInText("open C:\\Users\\Alice\\logs\\x failed")).not.toContain("Alice");
    expect(redactPathsInText("a plain message with no path")).toBe("a plain message with no path");
  });

  it("reads model breakdowns into normalized token/cost objects", () => {
    expect(
      readModelBreakdowns([
        {
          modelName: "gpt-5.5",
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          totalTokens: 20,
          cost: 0.01,
          prompt: "should not matter",
        },
      ]),
    ).toEqual([
      {
        modelName: "gpt-5.5",
        tokens: { input: 10, output: 5, cacheCreation: 2, cacheRead: 3, total: 20 },
        estimatedCost: { usd: 0.01, label: "Estimated API-equivalent cost" },
      },
    ]);
  });

  it("computes a model breakdown's total from its component fields when ccusage omits totalTokens on the entry", () => {
    // The real ccusage wire shape for modelBreakdowns[] entries has NO
    // totalTokens key — the total must be derived from the components.
    const b = readModelBreakdowns([
      { modelName: "m1", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 40, cost: 1 },
    ]);
    expect(b[0].tokens.total).toBe(200);
  });

  it("still honors an explicit totalTokens on a row when present", () => {
    const t = readTokens({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 999 });
    expect(t.total).toBe(999); // not overridden by 150
  });
});

function sampleScan(): UsageScan {
  return {
    scanned_at: 1_784_068_400,
    source,
    raw: "this raw ccusage blob is intentionally ignored by the normalizer",
    parsed: {
      daily: [
        {
          agent: "all",
          period: "2026-07-14",
          inputTokens: 500,
          outputTokens: 160,
          cacheCreationTokens: 30,
          cacheReadTokens: 110,
          totalTokens: 800,
          totalCost: 0.28,
          agents: [
            {
              agent: "claude",
              inputTokens: 300,
              outputTokens: 100,
              cacheCreationTokens: 20,
              cacheReadTokens: 80,
              totalTokens: 500,
              totalCost: 0.2,
              modelsUsed: ["claude-sonnet-4"],
            },
            {
              agent: "codex",
              inputTokens: 200,
              outputTokens: 60,
              cacheCreationTokens: 10,
              cacheReadTokens: 30,
              totalTokens: 300,
              totalCost: 0.08,
              modelsUsed: ["gpt-5.5"],
            },
          ],
        },
      ],
      weekly: [],
      monthly: [],
      session: [
        {
          agent: "codex",
          period: "2026/07/14/codex-run",
          inputTokens: 350,
          outputTokens: 80,
          cacheCreationTokens: 10,
          cacheReadTokens: 60,
          totalTokens: 500,
          totalCost: 0.2,
          modelsUsed: ["gpt-5.5"],
          metadata: {
            projectPath: "/Users/alice/work/secret-project",
            lastActivity: "2026-07-14T22:00:00.000Z",
            prompt: "Please refactor my private code",
          },
          rawTranscript: "const privateSecret = 'do not show';",
        },
        {
          agent: "claude",
          period: "/Users/alice/work/second-secret/session.jsonl",
          inputTokens: 500,
          outputTokens: 100,
          cacheCreationTokens: 20,
          cacheReadTokens: 140,
          totalTokens: 760,
          totalCost: 0.28,
          modelBreakdowns: [
            {
              modelName: "claude-sonnet-4",
              inputTokens: 500,
              outputTokens: 100,
              cacheCreationTokens: 20,
              cacheReadTokens: 140,
              totalTokens: 760,
              cost: 0.28,
            },
          ],
        },
      ],
      totals: {
        inputTokens: 850,
        outputTokens: 180,
        cacheCreationTokens: 30,
        cacheReadTokens: 200,
        totalTokens: 1260,
        totalCost: 0.48,
      },
    },
  };
}
