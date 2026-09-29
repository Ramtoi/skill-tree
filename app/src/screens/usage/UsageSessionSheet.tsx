import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Modal";
import type { UsageSessionRow } from "@/features/usage/usageTypes";
import { UsageInspectionPanel } from "./UsageInspectionPanel";
import { shortId } from "./usageFormat";

/** The sheet reads captured evidence by identity; list token/cost data is optional. */
export type UsageSessionSheetSession = Pick<UsageSessionRow, "id" | "period" | "harnessId" | "harnessName" | "title" | "inspection">;
export interface UsageSessionSheetProps { session: UsageSessionSheetSession | null; onClose: () => void; }
function sessionKey(session: UsageSessionSheetSession) { return session.inspection?.root_session_id ?? session.id ?? session.period; }

export function UsageSessionSheet({ session, onClose }: UsageSessionSheetProps) {
  const pins = useUsageSessionPins();
  if (!session) return null;
  const harness = session.harnessId === "claude" ? "claude-code" : session.harnessId;
  const id = sessionKey(session);
  const runId = session.inspection && session.inspection.root_session_id !== session.id ? session.inspection.run_id : null;
  const pinned = pins.isPinned(harness, id, runId);
  return <Sheet open onClose={onClose} side="right" width={720} title={session.title ?? `${session.harnessName} session ${shortId(session.period)}`} aria-label="Session details" className="usage-session-sheet">
    <div className="usage-sheet-body" data-testid="usage-session-sheet">
      <div className="usage-sheet-toolbar"><span className="usage-note">Captured transcript evidence</span><Button variant="ghost" size="sm" icon="pin" title={pinned ? "Unpin session" : "Pin session"} aria-label={pinned ? "Unpin session" : "Pin session"} aria-pressed={pinned} busy={pins.isMutating} onClick={() => pins.mutate({ action: pinned ? "remove" : "add", harness, sessionId: id, runId })} /></div>
      {session.inspection?.latest_pr && <a className="usage-pr-link" href={session.inspection.latest_pr.url} onClick={(event) => { event.preventDefault(); void openUrl(session.inspection!.latest_pr!.url); }}>PR #{session.inspection.latest_pr.number}</a>}
      <UsageInspectionPanel harness={harness} sessionId={id} initialRunId={runId} />
      {pins.mutation.isError && <p className="usage-note usage-inspection-error">Could not update pin. Try again.</p>}
      <span className="usage-inspection-source"><Icon name="shield" size={12} /> Captured transcript · ccusage totals remain separate</span>
    </div>
  </Sheet>;
}
