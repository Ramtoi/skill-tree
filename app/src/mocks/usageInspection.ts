import fixture from "../../../tests/fixtures/usage/inspection-session.json";
import nativeParity from "../test/fixtures/usage_native_parity.json";
import type { InspectionBodyPayload, InspectionIndexPayload, InspectionNativeFacts, InspectionPayload, InspectionPin, InspectionPinsPayload } from "@/features/usage/usageInspectionTypes";
import { PRUNED_DEMO_BODIES, PRUNED_DEMO_CHANGE, PRUNED_DEMO_TOOL_CALLS } from "./usageInspectionPruned";
import { sceneFlag, sceneValue } from "./scenes";

type CapturedBundle = {
  session_id?: string;
  overview?: InspectionPayload;
  tools?: InspectionPayload["tool_calls"] & { ok?: boolean; schema_version?: number; tool_calls?: InspectionPayload["tool_calls"] };
  changes?: { ok: boolean; changes?: InspectionPayload["changes"]; evidence?: InspectionPayload["evidence"] };
  body?: InspectionBodyPayload;
  bodies?: Record<string, InspectionBodyPayload>;
  pins?: InspectionPinsPayload;
};
type FixtureShape = typeof fixture & {
  captured_contract?: { index?: InspectionIndexPayload; "claude-code"?: CapturedBundle; codex?: CapturedBundle };
  codex?: { index?: typeof fixture.index; overview?: typeof fixture.overview; body?: typeof fixture.body & { text?: string }; pins?: typeof fixture.pins };
};
const source = fixture as FixtureShape;
const session = fixture.index.sessions[0];
const pinKey = (harness: string, sessionId: string, runId: string | null) => `${harness}|${sessionId}|${runId ?? "session"}`;
const captured = source.captured_contract;
const capturedPins = [captured?.["claude-code"]?.pins?.items ?? [], captured?.codex?.pins?.items ?? []]
  .flat()
  .filter((pin) => pin.root_session_id === captured?.index?.sessions?.find((row) => row.harness === pin.harness)?.root_session_id);
// The top-level pins fixture is the legacy aaaaaaaa example. Once generated
// contract pins exist, seed only those identities so Open always lands on a
// captured session and never transplants legacy breadcrumbs into it.
const seedPins = (capturedPins.length > 0 ? capturedPins : [...fixture.pins.items ?? [], ...source.codex?.pins?.items ?? []]) as unknown as InspectionPin[];
const PIN_STORAGE_KEY = "usage-inspection-mock-pins";
function readStoredPins(): string[] | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(PIN_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : [];
  } catch {
    return [];
  }
}
const storedPins = readStoredPins();
const pins = new Set((storedPins ?? seedPins.map((pin) => pinKey(pin.harness, pin.session_id, pin.run_id))));

function persistPins() {
  if (typeof window !== "undefined") window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([...pins]));
}

function arg(values: string[], name: string) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function pinItem(harness: string, sessionId: string, runId: string | null): InspectionPin {
  const existing = seedPins.find((pin) => pinKey(pin.harness, pin.session_id, pin.run_id) === pinKey(harness, sessionId, runId));
  const bundle = captured?.[harness as "claude-code" | "codex"];
  const run = runId ? bundle?.overview?.runs?.find((candidate) => candidate.id === runId) : undefined;
  if (existing) {
    if (!runId) return existing;
    const label = run?.label ?? `Agent · ${runId.slice(0, 8)}`;
    if (existing.breadcrumb?.some((crumb) => crumb.label === label)) return existing;
    return { ...existing, root_type: "agent", breadcrumb: [...(existing.breadcrumb ?? []), { label, status: run ? "available" : "unavailable" }] };
  }
  if (run) {
    const ancestors = bundle?.overview?.runs?.filter((candidate) => candidate.id === run.parent_id).map((candidate) => ({ label: candidate.label, status: "available" as const })) ?? [];
    const isRoot = run.parent_id === null;
    return { harness, session_id: sessionId, root_session_id: sessionId, run_id: isRoot ? null : runId, root_type: isRoot ? "session" : "agent", status: "available", breadcrumb: isRoot ? [] : [...ancestors, { label: run.label, status: "available" }], scopes: { own: run.scopes.own, subtree: run.scopes.subtree } };
  }
  const summary = bundle?.overview?.session?.summary;
  const scopes = summary ? { own: summary.own, subtree: summary.subtree } : { own: session.scopes.own, subtree: session.scopes.subtree };
  return { harness, session_id: sessionId, root_session_id: sessionId, run_id: null, root_type: "session", status: "available", breadcrumb: [], scopes: scopes as unknown as InspectionPin["scopes"] };
}

export function dispatchUsageInspection(args?: Record<string, unknown>): unknown {
  const values = Array.isArray(args?.args) ? args.args as string[] : [];
  const sessionId = values[1] === "pin" ? values[3] : values[2];
  const harness = arg(values, "--harness") ?? "claude-code";
  const contract = captured?.[harness as "claude-code" | "codex"];
  const codex = source.codex;
  const codexOverview = codex?.overview && "runs" in codex.overview ? codex.overview : null;
  const codexBodyId = codexOverview?.tool_calls?.items?.[0]?.result_parts?.[0]?.body_id;
  const codexBody = codex?.body?.text && codexBodyId ? { ok: true, body_id: codexBodyId, status: "available", content_type: codex.body.content_type ?? "text/plain", total_bytes: codex.body.total_bytes ?? new TextEncoder().encode(codex.body.text).length, chunks: [{ seq: 0, bytes: codex.body.total_bytes ?? new TextEncoder().encode(codex.body.text).length, base64: btoa(codex.body.text) }], next_after_chunk: null } : null;
  const harnessOverview = contract?.overview ?? (harness === "codex" && codexOverview ? codexOverview : fixture.overview);
  // Retention demo: a retained request next to a pruned result, a pruned
  // input, hash-vs-summary grouping, and a pruned patch, reachable at
  // /?usagePruned=1#/usage/session/<claude-code session>. Layered on top of
  // the base captured contract so the shared fixture stays untouched.
  const prunedScene = harness === "claude-code" && sceneFlag("usagePruned");
  const baseTools = contract?.tools?.tool_calls ?? contract?.tools ?? harnessOverview.tool_calls;
  const harnessTools = prunedScene ? { ...baseTools, items: [...baseTools.items, ...PRUNED_DEMO_TOOL_CALLS], total: baseTools.items.length + PRUNED_DEMO_TOOL_CALLS.length } : baseTools;
  const baseChanges = contract?.changes?.changes ? { ...harnessOverview, changes: contract.changes.changes, evidence: contract.changes.evidence ?? harnessOverview.evidence } : harnessOverview;
  const harnessChanges = prunedScene ? { ...baseChanges, changes: [...(baseChanges.changes ?? []), PRUNED_DEMO_CHANGE] } : baseChanges;
  const harnessBody = contract?.body ?? (harness === "codex" && (codex?.body?.ok || codexBody) ? (codex.body?.ok ? codex.body : codexBody!) : fixture.body);
  const harnessPins = contract?.pins ?? (harness === "codex" && codex?.pins?.ok ? codex.pins : fixture.pins);
  const capturedSessionId = contract?.session_id ?? harnessOverview.session?.key.session_id ?? (harness === "codex" && codexOverview?.session?.key.session_id ? codexOverview.session.key.session_id : session.session_id);
  if (values[1] === "inspect-index") {
    const contractIndex = captured?.index;
    const tokenScene = sceneValue("usageTokens");
    if (contractIndex && (tokenScene === "complete" || tokenScene === "partial")) {
      return { ...contractIndex, sessions: contractIndex.sessions?.map((item) => item.harness === "claude-code" ? {
        ...item, summary_provenance: "canonical", capture_coverage: tokenScene,
        scopes: {
          ...item.scopes,
          own: { ...item.scopes.own, tokens: { input: 100, output: 10, cache_creation: 0, cache_read: 0, total: 110, status: "available" } },
          children: { ...item.scopes.children, tokens: { input: 700, output: 10, cache_creation: 0, cache_read: 0, total: 710, status: "available" } },
          subtree: { ...item.scopes.subtree, tokens: { input: 800, output: 20, cache_creation: 0, cache_read: 0, total: 820, status: "available" } },
        },
      } : item) };
    }
    const nativeScene = sceneValue("usageNative");
    if (contractIndex && nativeScene && ["observed", "partial", "unavailable"].includes(nativeScene)) {
      // Native fields share the transcript-derived Python/TypeScript parity fixture.
      // The scene changes availability only; it never reads local transcripts.
      const unavailable: InspectionNativeFacts = {
        lines_added: null, lines_removed: null, duration_ms: null, branch: null,
        tool_calls: null, tool_breakdown: [], status: "unavailable",
        field_status: { lines_added: "unavailable", lines_removed: "unavailable", duration_ms: "unavailable", branch: "unavailable", tool_calls: "unavailable", tool_breakdown: "unavailable" },
      };
      const own = nativeScene === "unavailable" ? unavailable : {
        ...nativeParity.native.own,
        ...(nativeScene === "partial" ? { status: "partial", field_status: { ...nativeParity.native.own.field_status, tool_calls: "partial", tool_breakdown: "partial" } } : {}),
      };
      return { ...contractIndex, sessions: contractIndex.sessions?.map((item) => item.harness === "claude-code" ? {
        ...item, status: nativeScene === "observed" ? "available" : nativeScene,
        native: { own, children: unavailable, subtree: own }, agents: [],
        latest_pr: nativeScene === "unavailable" ? null : nativeParity.latest_pr,
        pinned: pins.has(pinKey(item.harness, item.root_session_id, null)),
      } : item) };
    }
    const familyScene = sceneFlag("codexFamilies");
    if (contractIndex && familyScene) {
      const childRun = captured?.codex?.overview?.runs?.find((run) => run.parent_id !== null);
      return { ...contractIndex, sessions: contractIndex.sessions?.map((item) => ({
        ...item,
        ...(item.harness === "codex" && childRun ? { agents: [{ session_id: "22222222-2222-4222-8222-222222222222", run_id: childRun.id }] } : {}),
        pinned: pins.has(pinKey(item.harness, item.root_session_id, null)),
      })) };
    }
    if (contractIndex) return { ...contractIndex, sessions: contractIndex.sessions?.map((item) => ({ ...item, pinned: pins.has(pinKey(item.harness, item.root_session_id, null)) })) };
    const codexIndex = codex?.index?.sessions ?? (codexOverview?.session ? [{ ...session, harness: "codex", session_id: capturedSessionId, root_session_id: capturedSessionId, scopes: codexOverview.session.summary, latest_pr: codexOverview.prs?.[0] ? { ...codexOverview.prs[0], last_evidenced_at: codexOverview.prs[0].last_evidenced_at } : null }] : []);
    const sessions = [...fixture.index.sessions, ...codexIndex.filter((item) => item.harness === "codex")];
    return { ...fixture.index, sessions: sessions.map((item) => ({ ...item, pinned: pins.has(pinKey(item.harness, item.root_session_id, null)) })) };
  }
  if (values[1] === "pin") {
    if (values[2] === "list") return { ...harnessPins, items: [...pins].map((key) => { const [itemHarness, itemSession, itemRun] = key.split("|"); return pinItem(itemHarness, itemSession, itemRun === "session" ? null : itemRun); }) };
    const runId = arg(values, "--run") ?? null;
    if (!sessionId) return { ok: false, reason: "missing_session" };
    const key = pinKey(harness, sessionId, runId);
    if (values[2] === "add") pins.add(key);
    if (values[2] === "remove") pins.delete(key);
    persistPins();
    return { ok: true, schema_version: 1, action: values[2], pin: { harness, session_id: sessionId, root_session_id: sessionId, run_id: runId } };
  }
  if (values[1] !== "inspect") return { ok: false, reason: "unavailable" };
  if (sessionId !== capturedSessionId || (harness !== session.harness && !contract && !codexOverview)) return { ok: false, reason: "not_captured" };
  if (values.includes("body")) {
    const bodyId = arg(values, "--body");
    const demoBody = bodyId ? PRUNED_DEMO_BODIES[bodyId] : undefined;
    if (demoBody) return { ok: true, body_id: bodyId, status: "available", content_type: demoBody.content_type, total_bytes: new TextEncoder().encode(demoBody.text).length, chunks: [{ seq: 0, bytes: new TextEncoder().encode(demoBody.text).length, base64: btoa(demoBody.text) }], next_after_chunk: null };
    const mappedBody = bodyId ? contract?.bodies?.[bodyId] : undefined;
    if (mappedBody) return mappedBody;
    if (bodyId === harnessBody.body_id) return harnessBody;
    return { ok: false, body_id: bodyId, status: "unavailable", reason: "body_not_retained" };
  }
  if (values.includes("--view") && values.includes("tools") && harnessTools) {
    const requestedRun = arg(values, "--run");
    // Match the real command: tools is a paged bare view and an explicit run
    // narrows that page. The panel omits --run so All agents can retain the
    // complete chronology and filter locally with overview run metadata.
    if (!requestedRun) return harnessTools;
    return { ...harnessTools, items: harnessTools.items.filter((item) => item.run_id === requestedRun), total: harnessTools.items.filter((item) => item.run_id === requestedRun).length, next_after: null };
  }
  if (values.includes("--view") && values.includes("changes")) return harnessChanges;
  return harnessOverview;
}
