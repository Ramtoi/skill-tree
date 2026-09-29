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
        provenance: "scanned",
        costKnown: true,
        splitKnown: true,
        harnesses: [
          {
            id: "claude",
            name: "Claude Code",
            tokens: { input: 300, output: 100, cacheCreation: 20, cacheRead: 80, total: 500 },
            estimatedCost: { usd: 0.2, label: "Estimated API-equivalent cost" },
            costKnown: true,
            splitKnown: true,
            models: [],
          },
          {
            id: "codex",
            name: "Codex",
            tokens: { input: 200, output: 60, cacheCreation: 10, cacheRead: 30, total: 300 },
            estimatedCost: { usd: 0.08, label: "Estimated API-equivalent cost" },
            costKnown: true,
            splitKnown: true,
            models: [],
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

  it("reads the new session metadata contract (title, branch, PR link, tool calls, lines, duration, hub project)", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 100,
            totalCost: 1,
            metadata: {
              projectPath: "/Users/alice/work/skill-tree",
              title: "Snippets screen redesign",
              titleSource: "custom",
              gitBranch: "design/snippets",
              prNumber: 90,
              prUrl: "https://github.com/acme/skill-tree/pull/90",
              toolCalls: 212,
              linesAdded: 2529,
              linesRemoved: 1421,
              durationMs: 5_268_720,
              hubProject: "skill-tree",
            },
          },
        ],
        totals: {},
      },
    });

    expect(snapshot.sessions[0]).toMatchObject({
      title: "Snippets screen redesign",
      titleSource: "custom",
      branch: "design/snippets",
      pr: { number: 90, url: "https://github.com/acme/skill-tree/pull/90" },
      toolCalls: 212,
      linesAdded: 2529,
      linesRemoved: 1421,
      durationMs: 5_268_720,
      hubProject: "skill-tree",
    });
  });

  it("does not surface a pr link when the url is missing or not https", () => {
    const noUrl = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          { agent: "claude", period: "uuid-1", totalTokens: 10, totalCost: 0.1, metadata: { prNumber: 5 } },
        ],
        totals: {},
      },
    });
    expect(noUrl.sessions[0].pr).toBeUndefined();

    const nonHttps = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 10,
            totalCost: 0.1,
            metadata: { prNumber: 5, prUrl: "ssh://github.com/acme/skill-tree/pull/5" },
          },
        ],
        totals: {},
      },
    });
    expect(nonHttps.sessions[0].pr).toBeUndefined();
  });

  it("groups sessions under a hub project name and keeps fallback letter ordering unaffected", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          // 0: no hubProject, path A → "Project A"
          {
            agent: "claude",
            period: "uuid-0",
            totalTokens: 500,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/first-repo" },
          },
          // 1 & 2: same hubProject, DIFFERENT cwds → must share one label,
          // and must NOT consume a letter from the fallback sequence.
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 400,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/skill-tree", hubProject: "skill-tree" },
          },
          {
            agent: "codex",
            period: "uuid-2",
            totalTokens: 300,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/worktrees/skill-tree/feat", hubProject: "skill-tree" },
          },
          // 3: no hubProject, path B (distinct from path A) → "Project B",
          // NOT "Project C" — proves the hub-project sessions above didn't
          // shift the fallback letter counter.
          {
            agent: "claude",
            period: "uuid-3",
            totalTokens: 200,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/second-repo" },
          },
        ],
        totals: {},
      },
    });

    const byTokens = (n: number) => snapshot.sessions.find((s) => s.tokens.total === n)!;
    expect(byTokens(500).project?.label).toBe("Project A");
    expect(byTokens(400).project?.label).toBe("skill-tree");
    expect(byTokens(300).project?.label).toBe("skill-tree");
    expect(byTokens(200).project?.label).toBe("Project B");

    const skillTreeProject = snapshot.projects.find((p) => p.key === "skill-tree")!;
    expect(skillTreeProject).toMatchObject({ label: "skill-tree", sessions: 2 });
    expect(skillTreeProject.tokens.total).toBe(700);
  });

  it("gives a redacted codex cache path (~/redacted/<hash>) a letter label, never the hash", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "codex",
            period: "uuid-1",
            totalTokens: 100,
            totalCost: 1,
            metadata: { projectPath: "~/redacted/9f8e7d6c5b4a3210" },
          },
        ],
        totals: {},
      },
    });

    const project = snapshot.sessions[0].project;
    expect(project?.label).toMatch(/^Project [A-Z]$/);
    expect(project?.label).not.toContain("9f8e7d6c5b4a3210");
  });

  it("scrubs path runs out of a session title", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 10,
            totalCost: 0.1,
            metadata: { title: "Fix bug in /Users/alice/work/secret-project/utils.ts" },
          },
        ],
        totals: {},
      },
    });

    expect(snapshot.sessions[0].title).toBe("Fix bug in <redacted-path>");
  });

  it("aggregates toolCalls per harness, per project, and in the overview", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 100,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/repo-a", toolCalls: 10 },
          },
          {
            agent: "claude",
            period: "uuid-2",
            totalTokens: 100,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/repo-a", toolCalls: 15 },
          },
          {
            agent: "codex",
            period: "uuid-3",
            totalTokens: 100,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/work/repo-b", toolCalls: 7 },
          },
        ],
        totals: {},
      },
    });

    expect(snapshot.harnesses.find((h) => h.id === "claude")?.toolCalls).toBe(25);
    expect(snapshot.harnesses.find((h) => h.id === "codex")?.toolCalls).toBe(7);
    expect(snapshot.overview.toolCalls).toBe(32);
    const repoA = snapshot.projects.find((p) => p.label === "Project A")!;
    expect(repoA.toolCalls).toBe(25);
  });

  it("computes overview.cacheHitRate, including the zero-denominator case", () => {
    const withCache = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 20,
            cacheReadTokens: 80,
            totalTokens: 250,
            totalCost: 1,
          },
        ],
        totals: {},
      },
    });
    // cacheRead 80 / (input 100 + cacheRead 80 + cacheCreation 20) = 0.4
    expect(withCache.overview.cacheHitRate).toBeCloseTo(0.4);

    const empty = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: { daily: [], session: [], totals: {} },
    });
    expect(empty.overview.cacheHitRate).toBe(0);
  });

  it("merges model breakdowns across harnesses and sorts by cost desc, then tokens, then name", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "uuid-1",
            totalTokens: 100,
            totalCost: 5,
            modelBreakdowns: [
              { modelName: "shared-model", inputTokens: 60, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 100, cost: 5 },
            ],
          },
          {
            agent: "codex",
            period: "uuid-2",
            totalTokens: 50,
            totalCost: 1,
            modelBreakdowns: [
              { modelName: "shared-model", inputTokens: 30, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 50, cost: 1 },
            ],
          },
          {
            agent: "codex",
            period: "uuid-3",
            totalTokens: 20,
            totalCost: 10,
            modelBreakdowns: [
              { modelName: "expensive-model", inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 20, cost: 10 },
            ],
          },
        ],
        totals: {},
      },
    });

    expect(snapshot.models.map((m) => m.modelName)).toEqual(["expensive-model", "shared-model"]);
    const shared = snapshot.models.find((m) => m.modelName === "shared-model")!;
    expect(shared.tokens.total).toBe(150);
    expect(shared.estimatedCost.usd).toBe(6);
  });

  it("groups projectless sessions under key 'unknown' / label 'No project'", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          { agent: "claude", period: "uuid-1", totalTokens: 10, totalCost: 0.1 },
          { agent: "claude", period: "uuid-2", totalTokens: 20, totalCost: 0.2 },
          {
            agent: "claude",
            period: "uuid-3",
            totalTokens: 30,
            totalCost: 0.3,
            metadata: { projectPath: "/Users/alice/work/known-repo" },
          },
        ],
        totals: {},
      },
    });

    const unknown = snapshot.projects.find((p) => p.key === "unknown")!;
    expect(unknown).toBeDefined();
    expect(unknown.label).toBe("No project");
    expect(unknown.sessions).toBe(2);
    expect(snapshot.projects.some((p) => p.key === "unknown" && p.label !== "No project")).toBe(false);
  });
});

describe("usage privacy helpers", () => {
  it("anonymizes project paths deterministically", () => {
    expect(anonymizeProjectPath("/Users/alice/work/citrus-app", 0)).toEqual({
      label: "Project A",
      anonymized: true,
      redactedPath: "…/citrus-app",
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

  it("rejects a modelBreakdowns row with a NaN cost, whole — not coerced to 0", () => {
    // The on-disk cache is a plain file a user can hand-edit; a corrupt row
    // must not silently zero out its cost and still count toward the total.
    const rows = readModelBreakdowns([
      { modelName: "m1", inputTokens: 10, cost: Number.NaN },
      { modelName: "m2", inputTokens: 20, cost: 2 },
    ]);
    expect(rows).toEqual([
      {
        modelName: "m2",
        tokens: { input: 20, output: 0, cacheCreation: 0, cacheRead: 0, total: 20 },
        estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" },
      },
    ]);
  });

  it("rejects a negative or non-finite token field, and a non-string modelName", () => {
    for (const bad of [
      { modelName: "m", inputTokens: -1, cost: 1 },
      { modelName: "m", outputTokens: Number.POSITIVE_INFINITY, cost: 1 },
      { modelName: "m", totalTokens: Number.NaN, inputTokens: 10, cost: 1 },
      { modelName: 42, inputTokens: 10, cost: 1 },
      { modelName: "", inputTokens: 10, cost: 1 },
      { inputTokens: 10, cost: 1 },
    ]) {
      expect(readModelBreakdowns([bad])).toEqual([]);
    }
  });

  it("keeps a row whose fields are simply absent, defaulting them to 0", () => {
    expect(readModelBreakdowns([{ modelName: "m", cost: 1 }])).toEqual([
      {
        modelName: "m",
        tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
        estimatedCost: { usd: 1, label: "Estimated API-equivalent cost" },
      },
    ]);
  });
});

/** The disk cache (`state/usage-latest.json`) is a plain file: an older build
 *  wrote it, and a user can edit it. Everything below treats session metadata
 *  as untrusted input rather than as something the Rust enricher guarantees. */
describe("normalizeCcusageScan hardening against a messy or hand-edited cache", () => {
  /** One session row, everything else empty. */
  function scanWith(metadata: Record<string, unknown>, row: Record<string, unknown> = {}): UsageScan {
    return {
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          { agent: "claude", period: "uuid-1", totalTokens: 100, totalCost: 1, metadata, ...row },
        ],
        totals: {},
      },
    };
  }

  const firstSession = (metadata: Record<string, unknown>, row?: Record<string, unknown>) =>
    normalizeCcusageScan(scanWith(metadata, row)).sessions[0];

  it("joins Codex rollout rows by trailing UUID and keeps project-path display rewriting", () => {
    const rollout = firstSession({}, {
      agent: "codex",
      period: "2026/07/14/rollout-20260714-12345678-90ab-cdef-0123-456789abcdef",
    });
    expect(rollout.id).toBe("12345678-90ab-cdef-0123-456789abcdef");
    expect(rollout.period).toContain("rollout-20260714");
    const claude = firstSession({}, {
      agent: "claude",
      period: "/Users/alice/.claude/sessions/1dae0a69-6f00-4109-ab1c-873861269996",
    });
    expect(claude.period).toBe("Project A session");
  });

  // ── hubProject ─────────────────────────────────────────────────────────

  it("refuses a path-shaped hubProject and falls back to letter labels", () => {
    // Rust only ever writes a registry KEY here. A path in this field would
    // print a real local path as a project label — exactly what the screen
    // promises not to do unless the full-paths toggle is on.
    for (const leaked of ["/Users/alice/work/repo", "~/Dev/repo", "C:\\Users\\alice\\repo"]) {
      const session = firstSession({ projectPath: "/Users/alice/work/repo", hubProject: leaked });
      expect(session.hubProject).toBeUndefined();
      expect(session.project?.label).toBe("Project A");
    }
  });

  it("refuses a ~/redacted/<hash> placeholder as a hubProject", () => {
    const session = firstSession({
      projectPath: "~/redacted/1a2b3c4d5e6f7081",
      hubProject: "~/redacted/1a2b3c4d5e6f7081",
    });
    expect(session.hubProject).toBeUndefined();
    expect(session.project?.label).toBe("Project A");
  });

  it("uses a hubProject verbatim as text, trimmed and length-capped", () => {
    // Markup is NOT stripped: the label renders as text (React escapes it), so
    // mangling it here would only hide what the registry really says.
    expect(firstSession({ hubProject: "  <b>skill-tree</b>  " }).hubProject).toBe("<b>skill-tree</b>");
    expect(firstSession({ hubProject: "   " }).hubProject).toBeUndefined();
    expect(firstSession({ hubProject: 42 }).hubProject).toBeUndefined();
    expect(firstSession({ hubProject: "z".repeat(500) }).hubProject).toHaveLength(120);
  });

  it("gives a hubProject session a project ref even with no path candidate", () => {
    // A claude row whose projectPath join missed still carries the hub name
    // (resolved from its own transcript). With no ref the row would read
    // "Local project" while the rollup filed it under "skill-tree".
    const snapshot = normalizeCcusageScan(scanWith({ hubProject: "skill-tree" }));
    const session = snapshot.sessions[0];
    expect(session.project).toEqual({ label: "skill-tree", anonymized: true });
    expect(session.project?.redactedPath).toBeUndefined();
    expect(session.project?.fullPath).toBeUndefined();
    expect(snapshot.projects.map((p) => [p.key, p.sessions])).toEqual([["skill-tree", 1]]);
  });

  // ── title ──────────────────────────────────────────────────────────────

  it("ignores a title that is not a usable string", () => {
    expect(firstSession({ title: 42 }).title).toBeUndefined();
    expect(firstSession({ title: "" }).title).toBeUndefined();
    expect(firstSession({ title: "   " }).title).toBeUndefined();
    expect(firstSession({ title: { text: "x" } }).title).toBeUndefined();
    expect(firstSession({ title: ["x"] }).title).toBeUndefined();
  });

  it("caps a title at 160 characters and drops the source when the title goes", () => {
    const long = firstSession({ title: "t".repeat(400), titleSource: "ai" });
    expect(long.title).toHaveLength(160);
    expect(long.titleSource).toBe("ai");
    const none = firstSession({ title: "   ", titleSource: "custom" });
    expect(none.title).toBeUndefined();
    expect(none.titleSource).toBeUndefined();
  });

  it("re-scrubs a title that reached the cache with a path still in it", () => {
    const session = firstSession({ title: "Fix /Users/alice/Dev/app boot" });
    expect(session.title).toBe("Fix <redacted-path> boot");
    expect(session.title).not.toContain("alice");
  });

  // ── branch ─────────────────────────────────────────────────────────────

  it("refuses a branch that is path-shaped or a redaction placeholder", () => {
    // A branch renders verbatim as a chip, so a `~/redacted/<hash>` here would
    // surface the placeholder as a label.
    expect(firstSession({ gitBranch: "~/redacted/1a2b3c4d5e6f7081" }).branch).toBeUndefined();
    expect(firstSession({ gitBranch: "/Users/alice/Dev/app" }).branch).toBeUndefined();
    expect(firstSession({ gitBranch: "   " }).branch).toBeUndefined();
    expect(firstSession({ gitBranch: 7 }).branch).toBeUndefined();
    expect(firstSession({ gitBranch: "  design/snippets  " }).branch).toBe("design/snippets");
  });

  // ── pr link ────────────────────────────────────────────────────────────

  it("refuses every unusable pr number shape", () => {
    const url = "https://github.com/acme/app/pull/9";
    for (const prNumber of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 4.5, "9", null, undefined]) {
      expect(firstSession({ prNumber, prUrl: url }).pr).toBeUndefined();
    }
    expect(firstSession({ prNumber: 9, prUrl: url }).pr).toEqual({ number: 9, url });
  });

  it("refuses every non-https pr url, including a redacted one", () => {
    for (const prUrl of [
      "http://github.com/acme/app/pull/9",
      "javascript:alert(1)",
      "file:///Users/alice/pull/9",
      // What the cache redactor writes for an https URL that happens to carry
      // a `/Users/` segment: no longer https, so it can never become a link.
      "~/redacted/1a2b3c4d5e6f7081",
      42,
    ]) {
      expect(firstSession({ prNumber: 9, prUrl }).pr).toBeUndefined();
    }
  });

  // ── counters ───────────────────────────────────────────────────────────

  it("refuses a negative, fractional, or stringly-typed counter", () => {
    // A negative would SUBTRACT from the screen's totals; a float would render
    // as "3.5 tools".
    for (const bad of [-1, 3.5, "12", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const session = firstSession({ toolCalls: bad, linesAdded: bad, linesRemoved: bad });
      expect(session.toolCalls).toBeUndefined();
      expect(session.linesAdded).toBeUndefined();
      expect(session.linesRemoved).toBeUndefined();
    }
    const good = firstSession({ toolCalls: 0, linesAdded: 12, linesRemoved: 3, durationMs: 1500.5 });
    expect(good.toolCalls).toBe(0);
    expect(good.linesAdded).toBe(12);
    expect(good.linesRemoved).toBe(3);
    // A duration is a measurement, not a count: a fractional millisecond is
    // meaningful, a negative one is not.
    expect(good.durationMs).toBe(1500.5);
    expect(firstSession({ durationMs: -1 }).durationMs).toBeUndefined();
  });

  it("keeps a refused counter out of the overview and the rollups", () => {
    const snapshot = normalizeCcusageScan(scanWith({ toolCalls: -50, linesAdded: -10 }));
    expect(snapshot.overview.toolCalls).toBe(0);
    expect(snapshot.overview.linesAdded).toBe(0);
    expect(snapshot.harnesses.find((h) => h.id === "claude")!.toolCalls).toBe(0);
    expect(snapshot.projects[0].toolCalls).toBe(0);
  });

  // ── toolBreakdown ──────────────────────────────────────────────────────

  it("reads a well-formed toolBreakdown into a sorted, capped list", () => {
    const session = firstSession({ toolBreakdown: { Read: 5, Bash: 20, Edit: 5 } });
    // Sorted by count descending, ties broken by name ascending.
    expect(session.toolBreakdown).toEqual([
      { name: "Bash", count: 20 },
      { name: "Edit", count: 5 },
      { name: "Read", count: 5 },
    ]);
  });

  it("ignores a non-object toolBreakdown outright", () => {
    for (const bad of ["Bash", 42, ["Bash", 5], null, true]) {
      expect(firstSession({ toolBreakdown: bad }).toolBreakdown).toBeUndefined();
    }
  });

  it("drops a negative, fractional, or stringly-typed count but keeps the rest", () => {
    const session = firstSession({ toolBreakdown: { Bash: 10, Read: -1, Edit: 2.5, Write: "3" } });
    expect(session.toolBreakdown).toEqual([{ name: "Bash", count: 10 }]);
  });

  it("drops a path-shaped tool name", () => {
    const session = firstSession({
      toolBreakdown: { Bash: 10, "/usr/bin/bash": 5, "~/scripts/run": 3 },
    });
    expect(session.toolBreakdown).toEqual([{ name: "Bash", count: 10 }]);
  });

  it("drops a tool name over 64 characters — consistent with the Rust writer's own cap", () => {
    // Rust truncates a name to 64 chars before it ever writes the cache, so a
    // well-formed cache never carries a longer key; a 70-char one here can
    // only be hand tampering, and the normalizer refuses it whole rather than
    // re-truncating a value that should never exist in this shape.
    const long = "x".repeat(70);
    const short = "y".repeat(64);
    const session = firstSession({ toolBreakdown: { [long]: 9, [short]: 3 } });
    expect(session.toolBreakdown).toEqual([{ name: short, count: 3 }]);
  });

  it("caps at 16 entries, keeping the top by count then name", () => {
    const entries: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      entries[`Tool${String(i).padStart(2, "0")}`] = 20 - i; // Tool00 => 20 .. Tool19 => 1
    }
    const session = firstSession({ toolBreakdown: entries });
    expect(session.toolBreakdown).toHaveLength(16);
    expect(session.toolBreakdown!.map((e) => e.name)).toEqual(
      Array.from({ length: 16 }, (_, i) => `Tool${String(i).padStart(2, "0")}`),
    );
  });

  it("omits toolBreakdown entirely when nothing survives", () => {
    expect(firstSession({ toolBreakdown: {} }).toolBreakdown).toBeUndefined();
    expect(firstSession({ toolBreakdown: { "/a/b": 1 } }).toolBreakdown).toBeUndefined();
  });

  // ── reasoningOutputTokens ──────────────────────────────────────────────

  it("refuses a negative, fractional, or stringly-typed reasoningOutputTokens", () => {
    for (const bad of [-1, 3.5, "12", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(firstSession({ reasoningOutputTokens: bad }).reasoningOutputTokens).toBeUndefined();
    }
    expect(firstSession({ reasoningOutputTokens: 4_200 }).reasoningOutputTokens).toBe(4_200);
    expect(firstSession({ reasoningOutputTokens: 0 }).reasoningOutputTokens).toBe(0);
  });

  // ── cache hit rate ─────────────────────────────────────────────────────

  it("computes cacheHitRate from the prompt-token denominator only", () => {
    const rate = (totals: Record<string, number>) =>
      normalizeCcusageScan({
        scanned_at: 0,
        source,
        parsed: { daily: [], session: [], totals: { ...totals } },
      }).overview.cacheHitRate;

    // Only cache CREATION: nothing was read back, so the rate is 0 — which is
    // a different statement from "no data".
    expect(rate({ cacheCreationTokens: 1000, totalTokens: 1000 })).toBe(0);
    // Only input: same, 0.
    expect(rate({ inputTokens: 1000, totalTokens: 1000 })).toBe(0);
    // Output alone leaves an empty denominator → 0, never NaN or Infinity.
    expect(rate({ outputTokens: 5000, totalTokens: 5000 })).toBe(0);
    // A normal mix, unrounded (the screen formats it).
    expect(rate({ inputTokens: 100, cacheReadTokens: 300, totalTokens: 400 })).toBe(0.75);
    // Very large counts stay exact enough to render.
    expect(
      rate({ inputTokens: 1_000_000_000, cacheReadTokens: 9_000_000_000, totalTokens: 10_000_000_000 }),
    ).toBeCloseTo(0.9, 10);
  });

  // ── model merge ────────────────────────────────────────────────────────

  it("merges one model across harnesses and keeps a harness-tagged label separate", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "a",
            totalTokens: 100,
            totalCost: 1,
            modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: 10, cost: 1 }],
          },
          {
            agent: "codex",
            period: "b",
            totalTokens: 100,
            totalCost: 2,
            modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: 20, cost: 2 }],
          },
          {
            agent: "pi",
            period: "c",
            totalTokens: 100,
            totalCost: 3,
            // DOCUMENTED: ccusage labels some rows with a harness prefix. The
            // merge is by label, so "[pi] gpt-5.5" is a DIFFERENT model from
            // "gpt-5.5" — collapsing them would need a label parser that
            // guesses, and a wrong guess merges unrelated spend.
            modelBreakdowns: [{ modelName: "[pi] gpt-5.5", inputTokens: 30, cost: 3 }],
          },
        ],
        totals: {},
      },
    });

    expect(snapshot.models.map((m) => m.modelName)).toEqual(["[pi] gpt-5.5", "gpt-5.5"]);
    const merged = snapshot.models.find((m) => m.modelName === "gpt-5.5")!;
    expect(merged.tokens.input).toBe(30);
    expect(merged.estimatedCost.usd).toBe(3);
  });

  // ── project rollup ─────────────────────────────────────────────────────

  it("collapses one hubProject reported under different paths into a single rollup row", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          {
            agent: "claude",
            period: "a",
            totalTokens: 100,
            totalCost: 1,
            metadata: { projectPath: "/Users/alice/app", hubProject: "app" },
          },
          {
            agent: "claude",
            period: "b",
            totalTokens: 50,
            totalCost: 0.5,
            metadata: { projectPath: "/Users/alice/worktrees/app/feat", hubProject: "app" },
          },
        ],
        totals: {},
      },
    });
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({ key: "app", label: "app", sessions: 2 });
    expect(snapshot.projects[0].estimatedCost.usd).toBe(1.5);
  });

  it("sorts the No project bucket by cost like any other row, then by tokens", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [
          // No path, no hub project → the "No project" bucket, most expensive.
          { agent: "claude", period: "a", totalTokens: 10, totalCost: 9, metadata: {} },
          {
            agent: "claude",
            period: "b",
            totalTokens: 20,
            totalCost: 1,
            metadata: { hubProject: "cheap" },
          },
          // Zero cost but real tokens: still ranked, above the other zero-cost
          // row, by its token count.
          {
            agent: "claude",
            period: "c",
            totalTokens: 5000,
            totalCost: 0,
            metadata: { hubProject: "free-but-busy" },
          },
          {
            agent: "claude",
            period: "d",
            totalTokens: 1,
            totalCost: 0,
            metadata: { hubProject: "idle" },
          },
        ],
        totals: {},
      },
    });
    expect(snapshot.projects.map((p) => p.key)).toEqual([
      "unknown",
      "cheap",
      "free-but-busy",
      "idle",
    ]);
    expect(snapshot.projects[0].label).toBe("No project");
  });

  // ── session ordering ───────────────────────────────────────────────────

  it("keeps tied sessions in their reported order when sorting by tokens", () => {
    const rows = ["a", "b", "c", "d"].map((period) => ({
      agent: "claude",
      period,
      id: period,
      totalTokens: 100,
      totalCost: 1,
      metadata: {},
    }));
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: { daily: [], session: rows, totals: {} },
    });
    // Array.prototype.sort is stable (ES2019), so an all-ties list comes back
    // in input order instead of shuffling between runs.
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  // ── daily rows ─────────────────────────────────────────────────────────

  it("reads a daily row with nested agents[] and one without, including an unknown agent id", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [
          {
            agent: "all",
            period: "2026-07-14",
            totalTokens: 300,
            totalCost: 3,
            agents: [
              { agent: "claude", totalTokens: 200, totalCost: 2 },
              // An agent ccusage knows and Skill Tree does not: named by
              // title-casing the id, never dropped.
              { agent: "brand-new-cli", totalTokens: 100, totalCost: 1 },
            ],
          },
          // No agents[]: the row itself is the only point.
          { agent: "codex", period: "2026-07-15", totalTokens: 50, totalCost: 0.5 },
        ],
        session: [],
        totals: {},
      },
    });

    expect(snapshot.daily[0].harnesses.map((h) => [h.id, h.name])).toEqual([
      ["claude", "Claude Code"],
      ["brand-new-cli", "Brand New Cli"],
    ]);
    expect(snapshot.daily[1].harnesses.map((h) => h.id)).toEqual(["codex"]);
    // A daily-only harness has days but no sessions or tokens (the session
    // section is the sole writer of those).
    const unknown = snapshot.harnesses.find((h) => h.id === "brand-new-cli")!;
    expect(unknown).toMatchObject({ sessions: 0, days: 1, toolCalls: 0 });
    expect(unknown.tokens.total).toBe(0);
  });

  // ── backwards compatibility ────────────────────────────────────────────

  it("normalizes an OLD cached scan that carries none of the new metadata", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 1_784_068_400,
      source,
      parsed: {
        daily: [{ agent: "claude", period: "2026-07-14", totalTokens: 400, totalCost: 2 }],
        session: [
          {
            agent: "claude",
            period: "uuid-old",
            inputTokens: 100,
            cacheReadTokens: 300,
            totalTokens: 400,
            totalCost: 2,
            modelBreakdowns: [{ modelName: "claude-opus-5", inputTokens: 100, cost: 2 }],
            metadata: { projectPath: "--Users-alice-Dev-app--" },
          },
        ],
        totals: { inputTokens: 100, cacheReadTokens: 300, totalTokens: 400, totalCost: 2 },
      },
    });

    const session = snapshot.sessions[0];
    expect(session.title).toBeUndefined();
    expect(session.branch).toBeUndefined();
    expect(session.pr).toBeUndefined();
    expect(session.toolCalls).toBeUndefined();
    expect(session.hubProject).toBeUndefined();
    // Lettering, not a hub name — every old row lands in the anonymous scheme.
    expect(session.project?.label).toBe("Project A");
    // The derived fields still come out: the rate from the token counts, the
    // model list from the breakdowns, a rollup keyed by the letter label.
    expect(snapshot.overview.toolCalls).toBe(0);
    expect(snapshot.overview.cacheHitRate).toBe(0.75);
    expect(snapshot.overview.linesAdded).toBe(0);
    expect(snapshot.overview.linesRemoved).toBe(0);
    expect(snapshot.models.map((m) => m.modelName)).toEqual(["claude-opus-5"]);
    expect(snapshot.projects.map((p) => [p.key, p.sessions])).toEqual([["Project A", 1]]);
    // A per-session real breakdown, always present on the row.
    expect(session.modelBreakdown).toEqual([
      {
        modelName: "claude-opus-5",
        tokens: { input: 100, output: 0, cacheCreation: 0, cacheRead: 0, total: 100 },
        estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" },
      },
    ]);
  });

  it("gives every session an (empty) modelBreakdown array, never leaving it undefined", () => {
    const snapshot = normalizeCcusageScan({
      scanned_at: 0,
      source,
      parsed: {
        daily: [],
        session: [{ agent: "claude", period: "uuid-2", totalTokens: 10, totalCost: 0.1 }],
        totals: {},
      },
    });
    expect(snapshot.sessions[0].modelBreakdown).toEqual([]);
  });

  it("can only ever hand back the redacted placeholder as a cached row's full path", () => {
    // `includeFullPaths` is a rendering choice, not a de-redaction: a cached
    // scan already had every real path hashed by the Rust writer, so the
    // "full" path IS the placeholder. The screen additionally gates the toggle
    // on `usage.hasFullFidelityData` (source === "live"), so a cached scan is
    // never normalized with this flag in the first place.
    const snapshot = normalizeCcusageScan(scanWith({ projectPath: "~/redacted/1a2b3c4d5e6f7081" }), {
      includeFullPaths: true,
    });
    const project = snapshot.sessions[0].project!;
    expect(project.label).toBe("Project A");
    expect(project.fullPath).toBe("~/redacted/1a2b3c4d5e6f7081");
    expect(project.fullPath).not.toContain("Users");
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
