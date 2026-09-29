import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import fixture from "./fixtures/usage_native_child_parity.json";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import { renderWithProviders } from "./helpers";
import { applyDisplayTokenProjection, applyNativeProjection } from "@/features/usage/usageNative";
import { UsageSessionDetail } from "@/screens/usage/UsageSessionDetail";
import { presentUsageSession } from "@/screens/usage/usageSessionPresentation";
import type { UsageSessionFamily } from "@/screens/usage/usageSessionFamilies";
import type { InspectionIndexSession, InspectionNativeFacts } from "@/features/usage/usageInspectionTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function detailSession(tokens: number): UsageSessionRow {
  return {
    id: fixture.session_id, period: fixture.session_id, harnessId: "claude", harnessName: "Claude Code",
    models: [], tokens: { input: tokens, output: 0, cacheCreation: 0, cacheRead: 0, total: tokens },
    estimatedCost: { usd: 0, label: "Estimated API-equivalent cost" },
  };
}

function inspection(own: InspectionNativeFacts, latest_pr: InspectionIndexSession["latest_pr"] = null): InspectionIndexSession {
  return {
    ...inspectionFixture.index.sessions[0],
    harness: "claude-code", session_id: fixture.session_id,
    root_session_id: fixture.session_id, run_id: "fixture-root", status: "available",
    native: { own, children: fixture.expected.children.native, subtree: fixture.expected.subtree.native }, latest_pr,
  } as InspectionIndexSession;
}

it("keeps root detail own facts separate from child detail facts", () => {
  const root = inspection(fixture.expected.root.native as InspectionNativeFacts);
  const child = inspection(fixture.expected.child.native as InspectionNativeFacts, fixture.expected.child.pr_number ? {
    repository_id: "acme/repo", number: fixture.expected.child.pr_number,
    url: "https://github.com/acme/repo/pull/12", relationship: "created",
    last_evidenced_at: "2026-09-17T08:00:03Z",
  } : null);
  const view = renderWithProviders(
    <UsageSessionDetail session={applyNativeProjection(detailSession(fixture.expected.root.tokens_total), root)} currency="USD" eurRate={1} projectDisplay="Fixture" />,
  );
  expect(screen.getByText("110")).toBeInTheDocument();
  expect(screen.getByText("Read 1")).toBeInTheDocument();
  expect(screen.getByText("+10 / −0")).toBeInTheDocument();
  expect(screen.queryByText("Bash 1")).not.toBeInTheDocument();

  view.rerender(
    <UsageSessionDetail session={applyNativeProjection(detailSession(fixture.expected.child.tokens_total), child)} currency="USD" eurRate={1} projectDisplay="Fixture" />,
  );
  expect(screen.getByText("710")).toBeInTheDocument();
  expect(screen.getByText("Bash 1")).toBeInTheDocument();
  expect(screen.getByText("+4 / −0")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "PR #12" })).toBeInTheDocument();
  expect(screen.queryByText("Read 1")).not.toBeInTheDocument();
});

it("uses canonical own tokens for detail display while the provider row stays aggregate", () => {
  const root = inspection(fixture.expected.root.native as InspectionNativeFacts);
  root.summary_provenance = "canonical";
  root.capture_coverage = "complete";
  root.scopes = {
    ...root.scopes,
    own: { ...root.scopes.own, tokens: { input: 100, output: 10, cache_creation: 0, cache_read: 0, total: 110, status: "available" } },
  };
  renderWithProviders(<UsageSessionDetail session={applyDisplayTokenProjection(applyNativeProjection(detailSession(820), root))} currency="USD" eurRate={1} projectDisplay="Fixture" />);
  expect(screen.getByTitle("Input: 100")).toBeInTheDocument();
  expect(screen.getByTitle("Output: 10")).toBeInTheDocument();
  expect(screen.queryByTitle("Input: 800")).not.toBeInTheDocument();
});

it("keeps root and child own totals separate and marks partial provider coverage", () => {
  // The expanded row used to repeat every family member in its own list; the
  // session sheet's timeline owns that job now. What still has to hold is the
  // presentation underneath either surface: a root and a child each carry
  // their OWN scope total, never the subtree sum, and an incomplete capture
  // is labelled as provider totals. The row-level label itself is covered by
  // usage-token-coverage.journey.spec.ts.
  const scope = (total: number) => ({
    tokens: { input: total, output: 0, cache_creation: 0, cache_read: 0, total, status: "available" as const },
    cost: { currency: "USD", value: 2, status: "known" as const },
    timing: { first_at: null, last_at: null, active_ms: null, status: "unavailable" as const },
  });
  const rootInspection = inspection(fixture.expected.root.native as InspectionNativeFacts);
  rootInspection.summary_provenance = "canonical";
  rootInspection.capture_coverage = "complete";
  rootInspection.scopes = { own: scope(110), children: scope(710), subtree: scope(820) };
  const childId = "shortagent";
  const childInspection = { ...rootInspection, session_id: childId, scopes: { own: scope(710), children: scope(0), subtree: scope(710) } };
  const root = presentUsageSession({ ...detailSession(820), inspection: rootInspection });
  const child = presentUsageSession({ ...detailSession(710), id: childId, period: childId, inspection: childInspection });
  const family: UsageSessionFamily<typeof root> = { session: root, members: [root, child], parentUnavailable: false, contextOnly: false };

  expect(family.members.map((member) => member.tokens.total)).toEqual([110, 710]);
  expect(root.tokenCaptureCoverage).toBe("complete");

  const partial = presentUsageSession({ ...detailSession(820), inspection: { ...rootInspection, capture_coverage: "partial" } });
  expect(partial.tokenCaptureCoverage).toBe("partial");
  // A partial capture falls back to the provider aggregate rather than an
  // own-scope total it cannot prove.
  expect(partial.tokens.total).toBe(820);
});
