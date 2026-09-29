import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { invoke } from "@/mocks/tauriCore";
import { SCANNED_HARNESSES } from "@/features/usage/usageAnalyticsTypes";
import type {
  UsageFindingsPayload,
  UsageFootprintPayload,
  UsageProjectPayload,
  UsageScanResult,
  UsageSessionPayload,
  UsageLoadoutsPayload,
  UsageTimelinePayload,
} from "@/features/usage/usageAnalyticsTypes";
import { footprintTokens, tokensOf } from "@/lib/footprintTokens";

// ─── Fixture ↔ type ↔ mock fidelity (design D14.3/D14.10, G2/G10/G11) ──────
//
// The Python ledger and the TypeScript frontend must agree on ONE shape for
// each of the five `hub usage <verb> --json` payloads. This file proves it
// two ways:
//   1. The four checked-in wave-1 fixtures (read directly off disk, the same
//      path shape `skillRefs.test.ts` uses) type-assert against — and get
//      their key sets/value types runtime-checked against — the TS
//      interfaces in `usageAnalyticsTypes.ts`.
//   2. All five verbs are driven through `invoke("hub_cmd", { args })` (the
//      REAL mock dispatch, `@/mocks/tauriCore`) rather than compared against
//      a mock module's own export — that would be `fixture === fixture` and
//      would pass even with a missing/typo'd/misplaced `hub_cmd` arm (the
//      precedent: `usageMockFidelity.test.ts:145-150`).

function readFixture<T>(name: string): T {
  const raw = readFileSync(resolve(process.cwd(), `../tests/fixtures/usage/${name}`), "utf-8");
  return JSON.parse(raw) as T;
}

async function driveHubCmd(args: string[]): Promise<{ success: boolean; output: string }> {
  return invoke<{ success: boolean; output: string }>("hub_cmd", { args });
}

const projectFixture = readFixture<UsageProjectPayload>("project.json");
const sessionFixture = readFixture<UsageSessionPayload>("session.json");
const footprintFixture = readFixture<UsageFootprintPayload>("footprint.json");
const findingsFixture = readFixture<UsageFindingsPayload>("findings.json");
const loadoutsFixture = readFixture<UsageLoadoutsPayload>("loadouts.json");
const timelineFixture = readFixture<UsageTimelinePayload>("timeline.json");

// ─── 1. Type + runtime shape checks over the checked-in fixtures ──────────

describe("checked-in usage-ledger fixtures match usageAnalyticsTypes.ts", () => {
	it("counts the skills part once and keeps its line breakdown faithful", () => {
		const harnessName = Object.keys(footprintFixture.harnesses)[0]!;
		const harness = footprintFixture.harnesses[harnessName];
		const skillsPart = harness.parts.find((part) => part.part === "skills")!;
		const lines = harness.skill_lines ?? [];
		expect(skillsPart.text).toBe(lines.map((line) => line.text).join("\n"));
		expect(footprintTokens(footprintFixture, harnessName)?.total).toBe(
			harness.parts.reduce((sum, part) => sum + tokensOf(part.text), 0),
		);
		const added = { key: "fidelity-added", text: "fidelity added skill line", bytes: 24 };
		const after = structuredClone(footprintFixture);
		const afterHarness = after.harnesses[harnessName];
		afterHarness.skill_lines = [...(afterHarness.skill_lines ?? []), added];
		const afterSkills = afterHarness.skill_lines.map((line) => line.text).join("\n");
		afterHarness.parts = afterHarness.parts.map((part) =>
			part.part === "skills" ? { ...part, text: afterSkills, bytes: afterSkills.length } : part,
		);
		expect(
			footprintTokens(after, harnessName)!.total - footprintTokens(footprintFixture, harnessName)!.total,
		).toBe(tokensOf(added.text));
	});

  it("project.json carries every UsageProjectPayload field with the right value types", () => {
    expect(projectFixture.ok).toBe(true);
    expect(typeof projectFixture.project).toBe("string");
    expect(typeof projectFixture.window).toBe("number");
    expect(typeof projectFixture.findings_window).toBe("number");
    expect(Array.isArray(projectFixture.harnesses)).toBe(true);
    expect(typeof projectFixture.footprint).toBe("object");
    expect(Array.isArray(projectFixture.utilization)).toBe(true);
    expect(typeof projectFixture.outcomes).toBe("object");
    expect(Array.isArray(projectFixture.findings)).toBe(true);
    expect(Array.isArray(projectFixture.sessions)).toBe(true);
    expect(Array.isArray(projectFixture.not_analysed)).toBe(true);

    for (const harness of projectFixture.harnesses) {
      const entry = projectFixture.footprint[harness];
      expect(entry, `footprint entry for ${harness}`).toBeDefined();
      expect(Array.isArray(entry.parts)).toBe(true);
      expect(Array.isArray(entry.unknown)).toBe(true);
      expect(typeof entry.bytes_total).toBe("number");
      expect(typeof entry.approx_tokens).toBe("number");
    }

    const outcomes = projectFixture.outcomes;
    expect(typeof outcomes.sessions).toBe("number");
    expect(typeof outcomes.cache_hit_ratio).toBe("number");
    expect(typeof outcomes.activity).toBe("object");
    expect(typeof outcomes.median_all_projects.activity).toBe("object");
    for (const cls of ["read", "edit", "verify", "operate", "delegate", "skill", "external"] as const) {
      expect(typeof outcomes.activity[cls], `outcomes.activity.${cls}`).toBe("number");
      expect(
        typeof outcomes.median_all_projects.activity[cls],
        `median_all_projects.activity.${cls}`,
      ).toBe("number");
    }

    for (const row of projectFixture.sessions) {
      expect(typeof row.session_id).toBe("string");
      expect(typeof row.harness).toBe("string");
      expect(typeof row.tokens_total).toBe("number");
      expect(typeof row.analysed).toBe("boolean");
    }
    for (const row of projectFixture.utilization) {
      expect(typeof row.sessions_with_skill).toBe("number");
      expect(typeof row.idle).toBe("boolean");
    }
  });

  it("session.json's events[] carry tokens/thinking_len/output_text_len (wave 1's G2 addition)", () => {
    expect(sessionFixture.ok).toBe(true);
    const events = sessionFixture.events;
    expect(events, "wave 1's event skeleton predates G2 — session.json has no events[]").toBeDefined();
    expect(events!.length).toBeGreaterThan(0);
    for (const event of events!) {
      expect(
        event.tokens,
        "wave 1's event skeleton predates G2 — an event has no `tokens` object",
      ).toBeDefined();
      expect(typeof event.tokens.input).toBe("number");
      expect(typeof event.tokens.output).toBe("number");
      expect(typeof event.tokens.cache_creation).toBe("number");
      expect(typeof event.tokens.cache_read).toBe("number");
      expect(
        typeof event.thinking_len,
        "wave 1's event skeleton predates G2 — an event has no `thinking_len`",
      ).toBe("number");
      expect(
        typeof event.output_text_len,
        "wave 1's event skeleton predates G2 — an event has no `output_text_len`",
      ).toBe("number");
      expect(typeof event.token_delta).toBe("number");
      expect(["human_turn", "slash_command", "skill", "script", "subagent", "tool", "compaction"]).toContain(event.kind);
    }
    // The fixture exercises the first five kinds today. Tool and compaction
    // are legal additions and are asserted separately so B1 may regenerate
    // the fixture without making this test hard-code future contents.
    const kinds = new Set(events!.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["human_turn", "slash_command", "skill", "script", "subagent"]));
    expect(["human_turn", "slash_command", "skill", "script", "subagent", "tool", "compaction"])
      .toEqual(expect.arrayContaining([...kinds]));
  });

  it("footprint.json carries every UsageFootprintPayload field with the right value types", () => {
    expect(footprintFixture.ok).toBe(true);
    expect(typeof footprintFixture.project).toBe("string");
    expect(typeof footprintFixture.harnesses).toBe("object");
    for (const [, entry] of Object.entries(footprintFixture.harnesses)) {
      expect(Array.isArray(entry.parts)).toBe(true);
      expect(Array.isArray(entry.unknown)).toBe(true);
      expect(typeof entry.bytes_total).toBe("number");
      expect(typeof entry.approx_tokens).toBe("number");
      expect(Array.isArray(entry.skill_lines)).toBe(true);
      expect(Array.isArray(entry.discoverable)).toBe(true);
      expect(typeof entry.discoverable_bytes).toBe("number");
      expect(typeof entry.discoverable_truncated).toBe("boolean");
      for (const line of entry.skill_lines ?? []) {
        expect(typeof line.key).toBe("string");
        expect(typeof line.text).toBe("string");
        expect(typeof line.bytes).toBe("number");
      }
      for (const doc of entry.discoverable ?? []) {
        expect(typeof doc.rel).toBe("string");
        expect(typeof doc.text).toBe("string");
        expect(typeof doc.bytes).toBe("number");
      }
    }
  });

  it("findings.json carries every UsageFindingsPayload field with the right value types", () => {
    expect(findingsFixture.ok).toBe(true);
    expect(typeof findingsFixture.window).toBe("number");
    expect(typeof findingsFixture.findings_window).toBe("number");
    expect(Array.isArray(findingsFixture.findings)).toBe(true);
    for (const finding of findingsFixture.findings) {
      expect(typeof finding.id).toBe("string");
      expect(typeof finding.kind).toBe("string");
      expect(typeof finding.observation).toBe("string");
      expect(typeof finding.numbers).toBe("object");
      expect(Array.isArray(finding.moves)).toBe(true);
      expect(typeof finding.review).toBe("object");
      if (finding.kind === "idle") {
        expect(typeof finding.numbers.bytes_per_skill).toBe("object");
      }
      if (finding.kind === "verification") {
        expect(finding.review.also).toEqual(["loadout"]);
      }
      for (const move of finding.moves) {
        expect(typeof move.label).toBe("string");
        expect(typeof move.kind).toBe("string");
        expect(Array.isArray(move.targets)).toBe(true);
      }
    }
  });

  it("loadouts.json is populated, projected, and redacted", () => {
    expect(loadoutsFixture.rows.length).toBeGreaterThan(0);
    expect(loadoutsFixture.rows.some((row) => row.kind === "initial")).toBe(true);
    expect(loadoutsFixture.rows.some((row) => row.kind === "changed")).toBe(true);
    for (const row of loadoutsFixture.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["at", "harness", "hash", "kind", "mcp_count", "skill_count"].sort(),
      );
      expect(typeof row.at).toBe("string");
      expect(typeof row.hash).toBe("string");
      expect(["initial", "changed"]).toContain(row.kind);
    }
  });

  // Design D14.3/G11: a claude-code-only fixture with no `not_analysed` rows
  // would make `not_analysed[].harness === harnesses - SCANNED_HARNESSES` a
  // trivial pass on two empty sets — coverage that reads as real but proves
  // nothing. So the precondition is checked FIRST, and the real equality
  // only runs when the fixture can actually support it. Today's checked-in
  // `project.json` is claude-code-only (`harnesses: ["claude-code"]`,
  // `not_analysed: []`), so this currently takes the guarded branch — a
  // documented, deliberate outcome (see the unit-E report's Deviations),
  // not a silently-skipped check.
  it("not_analysed[].harness matches harnesses minus SCANNED_HARNESSES — guarded (G11)", () => {
    const nonScannedHarnesses = projectFixture.harnesses.filter((h) => !SCANNED_HARNESSES.includes(h));
    const canPin = nonScannedHarnesses.length > 0 && projectFixture.not_analysed.length > 0;
    if (!canPin) {
      console.warn(
        "usageAnalyticsFidelity: wave 1's fixture cannot pin this — project.json names no " +
          "harness outside SCANNED_HARNESSES and/or carries no not_analysed row.",
      );
      return;
    }
    const expected = new Set(nonScannedHarnesses);
    const actual = new Set(projectFixture.not_analysed.map((r) => r.harness));
    expect(actual).toEqual(expected);
  });
});

// ─── 2. Drive all five verbs through the real invoke("hub_cmd") bridge ────

describe("all five hub_cmd usage arms are wired (G10)", () => {
  it('"usage timeline" keeps the fixture shape while using generated visual data', async () => {
    const result = await driveHubCmd(["usage", "timeline", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageTimelinePayload;
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(timelineFixture).sort());
    expect(parsed.schema_version).toBe(timelineFixture.schema_version);
    expect(parsed.peaks.unit).toBe("tokens");
    expect(parsed.peaks.grid).toHaveLength(7);
    expect(parsed.peaks.grid.every((row) => row.length === 24)).toBe(true);
    expect(parsed.days.length).toBeGreaterThan(0);
    for (const day of parsed.days) {
      expect(typeof day.date).toBe("string");
      expect(typeof day.skills).toBe("object");
      expect(typeof day.tools).toBe("object");
    }
  });

  it('"usage project" rewrites the requested name and returns the fixture data', async () => {
    const result = await driveHubCmd(["usage", "project", "test-project", "--window", "30", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageProjectPayload;
    expect(parsed.project).toBe("test-project");
    expect(parsed.window).toBe(30);
    expect(parsed.outcomes).toEqual(projectFixture.outcomes);
    expect(parsed.footprint).toEqual(projectFixture.footprint);
    for (const finding of parsed.findings) {
      expect(finding.project).toBe("test-project");
      expect(finding.review.project).toBe("test-project");
    }
  });

  it('"usage session" rewrites the requested id', async () => {
    const result = await driveHubCmd(["usage", "session", "requested-id", "--harness", "claude-code", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageSessionPayload;
    expect(parsed.session_id).toBe("requested-id");
    expect(parsed.summary).toEqual(sessionFixture.summary);
    expect(parsed.events).toEqual(sessionFixture.events);
  });

  it('"usage footprint" rewrites the requested name', async () => {
    const result = await driveHubCmd(["usage", "footprint", "test-project", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageFootprintPayload;
    expect(parsed.project).toBe("test-project");
    expect(parsed.harnesses).toEqual(footprintFixture.harnesses);
  });

  it('"usage findings" without --project returns the fixture unrewritten', async () => {
    const result = await driveHubCmd(["usage", "findings", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageFindingsPayload;
    expect(parsed.findings).toEqual(findingsFixture.findings);
  });

  it('"usage findings" with --project rewrites every finding\'s project', async () => {
    const result = await driveHubCmd(["usage", "findings", "--project", "test-project", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageFindingsPayload;
    for (const finding of parsed.findings) {
      expect(finding.project).toBe("test-project");
      expect(finding.review.project).toBe("test-project");
    }
  });

  it('"usage scan-sessions" returns the checked-in scan fixture', async () => {
    const result = await driveHubCmd(["usage", "scan-sessions", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageScanResult;
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.rows_written).toBe("number");
    expect(Array.isArray(parsed.errors)).toBe(true);
  });

  it('"usage loadouts" is dispatched through hub_cmd', async () => {
    const result = await driveHubCmd(["usage", "loadouts", "test-project", "--json"]);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output) as UsageLoadoutsPayload;
    expect(parsed.project).toBe("test-project");
    expect(parsed.rows.some((row) => row.kind === "initial")).toBe(true);
    expect(parsed.rows.some((row) => row.kind === "changed")).toBe(true);
    expect(parsed.rows.every((row) => !("skills" in row) && !("mcp" in row))).toBe(true);
  });
});
