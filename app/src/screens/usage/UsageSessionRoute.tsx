import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ScreenHeader } from "@/components/ScreenHeader";
import { backReturnOptions, usageBackTarget, useBackTarget } from "@/lib/backTarget";
import { ScanButton } from "./UsageScanAction";
import { UsageScanRecovery } from "./UsageScanRecovery";
import { UsageInspectionPanel } from "./UsageInspectionPanel";
import { useUsageInspection, useUsageInspectionIndex } from "@/features/usage/useUsageInspection";
import { expandInspectionIndexRows } from "@/features/usage/useLocalAgentUsage";
import type { InspectionIndexSession } from "@/features/usage/usageInspectionTypes";
import { UsageSessionTimeline } from "./UsageSessionTimeline";
import { SkeletonRow } from "@/components/loading/Skeleton";

export function resolveInspectionTarget(id: string, explicitRun: string | null, rows: InspectionIndexSession[] | undefined, harness = "codex") {
  if (harness !== "codex" || !rows) return { sessionId: id, runId: explicitRun };
  const match = expandInspectionIndexRows(rows).find((row) => row.harness === harness && row.session_id === id);
  if (!match) return { sessionId: id, runId: explicitRun };
  return { sessionId: match.root_session_id, runId: explicitRun ?? (match.session_id === match.root_session_id ? null : match.run_id || null) };
}

export function UsageSessionRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const back = useBackTarget(usageBackTarget());
  const harness = useMemo(() => new URLSearchParams(location.search).get("harness") ?? "claude-code", [location.search]);
  const runId = useMemo(() => new URLSearchParams(location.search).get("run"), [location.search]);
  const inspectionIndex = useUsageInspectionIndex(harness === "codex");
  const target = useMemo(() => resolveInspectionTarget(id, runId, inspectionIndex.data?.sessions, harness), [id, runId, harness, inspectionIndex.data?.sessions]);
  const inspection = useUsageInspection(harness, target.sessionId, "overview", target.runId, harness !== "codex" || !inspectionIndex.isPending);
  const useLegacyTimeline = !inspection.isPending && inspection.data?.ok === false && inspection.data.reason === "not_captured";
  return <>
    <ScreenHeader title="Session inspection" back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }} meta={<code>{id.slice(0, 8)}</code>} crumbs={back.crumbs?.length === 2 ? back.crumbs : ["usage", "session"]} primary={<ScanButton />} />
    <div className="screen-pad usage-inspection-route"><UsageScanRecovery />{harness === "codex" && inspectionIndex.isPending ? <><SkeletonRow /><SkeletonRow /><SkeletonRow /></> : useLegacyTimeline ? <><p className="usage-note">This session has no captured inspection yet; showing the legacy usage timeline.</p><UsageSessionTimeline harness={harness} sessionId={target.sessionId} /></> : <UsageInspectionPanel harness={harness} sessionId={target.sessionId} initialRunId={target.runId} />}</div>
  </>;
}
