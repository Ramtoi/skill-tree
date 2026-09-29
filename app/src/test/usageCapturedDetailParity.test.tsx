import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import fixture from "./fixtures/usage_native_parity.json";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import { renderWithProviders } from "./helpers";
import { applyNativeProjection } from "@/features/usage/usageNative";
import { UsageSessionDetail } from "@/screens/usage/UsageSessionDetail";
import type { InspectionIndexSession, InspectionNativeFacts } from "@/features/usage/usageInspectionTypes";
import type { UsageSessionRow } from "@/features/usage/usageTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

it("renders the same captured native facts verified by the Python parser fixture", () => {
  const own = fixture.native.own as InspectionNativeFacts;
  const inspection = {
    harness: "claude-code", session_id: fixture.session_id,
    root_session_id: fixture.session_id, run_id: "fixture-run", status: "available",
    native: { own, children: own, subtree: own }, latest_pr: fixture.latest_pr,
    additional_pr_count: 0, pinned: false, scopes: inspectionFixture.index.sessions[0].scopes,
  } as InspectionIndexSession;
  const session: UsageSessionRow = {
    id: fixture.session_id, period: fixture.session_id, harnessId: "claude", harnessName: "Claude Code",
    models: [], tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    estimatedCost: { usd: 0, label: "Estimated API-equivalent cost" },
  };
  renderWithProviders(<UsageSessionDetail session={applyNativeProjection(session, inspection)} currency="USD" eurRate={1} projectDisplay="Fixture" />);
  expect(screen.getByText("+12 / −3")).toBeInTheDocument();
  expect(screen.getByText("1m")).toBeInTheDocument();
  expect(screen.getByText("feature/native-parity")).toBeInTheDocument();
  expect(screen.getByText("Agent 1 · Bash 1")).toBeInTheDocument();
  expect(screen.getByText("Sub-agents spawned")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "PR #42" })).toBeInTheDocument();
});

it("shows known partial tool evidence as a lower bound", () => {
  const own = { ...fixture.native.own, tool_calls: 1, tool_breakdown: [{ name: "Bash", count: 1 }], field_status: { ...fixture.native.own.field_status, tool_calls: "partial", tool_breakdown: "partial" } } as InspectionNativeFacts;
  const inspection = { ...inspectionFixture.index.sessions[0], native: { own, children: own, subtree: own } } as InspectionIndexSession;
  const session: UsageSessionRow = {
    id: fixture.session_id, period: fixture.session_id, harnessId: "claude", harnessName: "Claude Code",
    models: [], tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    estimatedCost: { usd: 0, label: "Estimated API-equivalent cost" },
  };
  renderWithProviders(<UsageSessionDetail session={applyNativeProjection(session, inspection)} currency="USD" eurRate={1} projectDisplay="Fixture" />);
  expect(screen.getByText("At least 1")).toBeInTheDocument();
  expect(screen.getByText("Bash 1")).toBeInTheDocument();
  expect(screen.getByText("Top tools (partial)")).toBeInTheDocument();
});

it("labels provider token breakdowns separately from canonical own tokens", () => {
  const session: UsageSessionRow = {
    id: fixture.session_id, period: fixture.session_id, harnessId: "codex", harnessName: "Codex",
    models: ["gpt-5.6"], tokens: { input: 100, output: 10, cacheCreation: 0, cacheRead: 0, total: 110 },
    modelBreakdown: [{ modelName: "gpt-5.6", tokens: { input: 800, output: 20, cacheCreation: 0, cacheRead: 0, total: 820 }, estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" } }],
    estimatedCost: { usd: 2, label: "Estimated API-equivalent cost" }, reasoningOutputTokens: 7,
  };
  renderWithProviders(<UsageSessionDetail session={session} currency="USD" eurRate={1} projectDisplay="Fixture" />);
  expect(screen.getByText("820 provider tokens")).toBeInTheDocument();
  expect(screen.getByText("Reasoning")).toBeInTheDocument();
  expect(screen.getByText("(provider tokens)")).toBeInTheDocument();
});
