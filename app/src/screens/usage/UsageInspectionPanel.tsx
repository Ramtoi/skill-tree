import { useFeedbackTab } from "@/hooks/useFeedbackTab";
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { Button } from "@/components/Button";
import { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorCard } from "@/components/ErrorCard";
import { SkeletonRow } from "@/components/loading/Skeleton";
import { useUsageInspection, useUsageInspectionBody } from "@/features/usage/useUsageInspection";
import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { unavailableReason, type InspectionPayload } from "@/features/usage/usageInspectionTypes";
import { bodyText, decodeBodyChunks } from "./usageInspectionModel";
import { UsageInspectionTimeline } from "./UsageInspectionTimeline";
import { UsageSessionChanges } from "./UsageSessionChanges";
import { UsageSessionToolCalls } from "./UsageSessionToolCalls";

type View = "timeline" | "tools" | "changes";
const VIEW_OPTIONS: readonly ChipRadioOption<View>[] = [
  { value: "timeline", label: "Timeline" },
  { value: "tools", label: "Tool calls" },
  { value: "changes", label: "Changes" },
];

export function UsageInspectionPanel({ harness, sessionId, initialView = "timeline", initialRunId = null }: { harness: string; sessionId: string; initialView?: View; initialRunId?: string | null }) {
  const [view, setView] = useState<View>(initialView);
  useFeedbackTab("usage-session", view);
  const [focusedRun, setFocusedRun] = useState<string | null>(initialRunId);
  const [toolRun, setToolRun] = useState<string | null>(initialRunId);
  const [bodyId, setBodyId] = useState<string | null>(null);
  const [bodyLabel, setBodyLabel] = useState("Captured body");
  const [bodyAfter, setBodyAfter] = useState<number | null>(null);
  const queryView = view === "timeline" ? "overview" : view;
  const query = useUsageInspection(harness, sessionId, queryView, focusedRun);
  const body = useUsageInspectionBody(harness, sessionId, bodyId, bodyAfter);
  const pins = useUsageSessionPins();
  const toast = useToast();
  const displayedText = !body.isFetching && !body.isError && body.data?.ok && body.data.chunks
    ? bodyText(decodeBodyChunks(body.data.chunks), body.data.content_type)
    : null;
  const copyDisplayedText = () => {
    if (displayedText === null) return;
    copyToClipboard(displayedText, {
      onSuccess: () => toast.success("Displayed text copied"),
      onError: () => toast.error("Couldn't copy displayed text", "Try again, or select and copy the text manually."),
    });
  };

  const openBody = (nextBodyId: string, label = "Captured body") => { setBodyId(nextBodyId); setBodyLabel(label); setBodyAfter(null); };
  const bodySideLabel = bodyLabel.toLowerCase().includes("input") ? "Input" : bodyLabel.toLowerCase().includes("patch") ? "Patch" : "Result";

  useEffect(() => { setView(initialView); setFocusedRun(initialRunId); setToolRun(initialRunId); setBodyId(null); setBodyLabel("Captured body"); setBodyAfter(null); }, [initialView, initialRunId, sessionId, harness]);
  const payload = query.data;
  return <div className="usage-inspection-panel" data-testid="usage-inspection-panel" data-tool-run={toolRun ?? "all-agents"}>
    <ChipRadios name="usage-inspection-view" label="Session inspection view" value={view} options={VIEW_OPTIONS} onChange={setView} />
    <div className="usage-inspection-content">
    {query.isPending && <div className="usage-sheet-skeleton"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>}
    {query.isError && <ErrorCard title="Captured inspection could not be read." description={query.error instanceof Error ? query.error.message : "The local inspection read failed."} actions={<button type="button" className="btn btn-soft btn-sm" onClick={() => void query.refetch()}>Retry</button>} />}
    {!query.isPending && !query.isError && !payload?.ok && <EmptyState icon="warning" title={unavailableReason(payload?.reason)} action={<Button size="sm" variant="soft" onClick={() => void query.refetch()}>Retry</Button>} />}
    {!query.isPending && !query.isError && payload?.ok && (() => {
      const inspection = payload as InspectionPayload;
      const evidenceStatus = inspection.evidence?.status ?? inspection.session?.status ?? "unavailable";
      return <>
        {view === "timeline" && <UsageInspectionTimeline payload={inspection} selectedRunId={focusedRun} onToolCalls={(runId) => { setFocusedRun(runId ?? null); setToolRun(runId ?? null); setView("tools"); }} onPin={(runId) => pins.mutate({ action: pins.isPinned(harness, sessionId, runId ?? null) ? "remove" : "add", harness, sessionId, runId })} isPinned={(runId) => pins.isPinned(harness, sessionId, runId ?? null)} pinBusy={pins.isMutating} />}
        {view === "tools" && inspection.tool_calls?.status === "partial" && <div className="usage-inspection-partial" role="alert"><span>Some retained Tool calls pages are unavailable.</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry Tool calls</Button></div>}
        {view === "tools" && <UsageSessionToolCalls key={toolRun ?? "all-agents"} calls={inspection.tool_calls?.items ?? []} runs={inspection.runs ?? []} selectedRunId={toolRun} onBody={openBody} streaming={query.isLoadingMore && inspection.tool_calls ? { loaded: inspection.tool_calls.items.length, total: inspection.tool_calls.total } : undefined} />}
        {view === "changes" && <UsageSessionChanges changes={inspection.changes ?? []} onBody={openBody} />}
        <div className={`usage-inspection-evidence is-${evidenceStatus}`} role="status" aria-label={`Capture evidence: ${evidenceStatus}`}><strong>Capture evidence: {evidenceStatus}</strong>{inspection.evidence?.notices?.map((notice, index) => <span key={`${notice}-${index}`}>{notice}</span>)}</div>
        {pins.mutation.isError && <p className="usage-note usage-inspection-error" role="alert">Could not update the pin. Try again.</p>}
        {inspection.prs && inspection.prs.length > 0 && <details className="usage-inspection-pr-picker" data-testid="usage-inspection-pr-picker"><summary>Additional PR evidence ({inspection.prs.length})</summary><div>{inspection.prs.map((pr) => <a key={`${pr.repository_id}:${pr.number}`} className="usage-pr-link" href={pr.url} onClick={(event) => { event.preventDefault(); void openUrl(pr.url); }}>#{pr.number} · {pr.repository_id} · {pr.relationship}</a>)}</div></details>}
      </>;
    })()}
    {bodyId && <section className="usage-inspection-body" aria-label="Captured body" data-body-id={bodyId}>
      <header><div className="usage-inspection-body-heading"><strong>{bodyLabel}</strong><Button size="sm" variant="ghost" icon="copy" disabled={displayedText === null} onClick={copyDisplayedText}>Copy displayed text</Button></div><button type="button" className="usage-inline-link" onClick={() => setBodyId(null)}>Close</button></header>
      {body.isFetching && <p className="usage-note">Loading retained body…</p>}
      {!body.isFetching && (body.isError || (body.data && !body.data.ok && body.data.reason !== "pruned")) && <div className="usage-inspection-partial" role="alert"><span>Retained body could not be read.</span><Button size="sm" variant="ghost" onClick={() => void body.refetch()}>Retry body</Button></div>}
      {displayedText !== null && <pre>{displayedText}</pre>}
      {!body.isFetching && body.data?.ok && body.data.status === "truncated" && <p className="usage-note">The retained source body is truncated; its available prefix can be read.</p>}
      {!body.isFetching && body.data?.retrieval_status && <div className="usage-inspection-partial" role="alert"><span>More body pages could not be retrieved. The retained prefix is shown.</span><Button size="sm" variant="ghost" onClick={() => void body.refetch()}>Retry body pages</Button></div>}
      {!body.isFetching && body.data?.next_after_chunk != null && !body.data.retrieval_status && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBodyAfter(body.data?.next_after_chunk ?? null)}>Load more</button>}
      {!body.isFetching && body.data && !body.data.ok && body.data.reason === "pruned" && <p className="usage-note" role="status">{bodySideLabel} was pruned{body.data.pruned_at ? ` · ${new Date(body.data.pruned_at).toLocaleDateString()}` : ""}. This content cannot be recovered.</p>}
      {!body.isFetching && body.data && !body.data.ok && body.data.reason !== "pruned" && <p className="usage-note">Body is {body.data.status ?? "unavailable"}.</p>}
    </section>}
    </div>
  </div>;
}
