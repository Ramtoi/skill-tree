import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useUsageSessionPins } from "@/features/usage/useUsageInspection";
import { unavailableReason } from "@/features/usage/usageInspectionTypes";
import { backReturnOptions, fromNav, usageBackTarget, useBackTarget } from "@/lib/backTarget";
import { ScanButton } from "./UsageScanAction";
import type { InspectionTokens } from "@/features/usage/usageInspectionTypes";

export function UsagePinnedSessionsRoute() {
  const navigate = useNavigate();
  const back = useBackTarget(usageBackTarget());
  const pins = useUsageSessionPins();
  return <>
    <ScreenHeader title="Pinned sessions" back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }} crumbs={["usage", "pinned"]} primary={<ScanButton />} />
    <div className="screen-pad usage-pinned-route" aria-label="Pinned sessions">
      {pins.isPending && <p className="usage-note">Loading pinned sessions…</p>}
      {pins.isError && <p className="usage-note" role="alert">Pinned sessions are unavailable. <Button size="sm" variant="ghost" onClick={() => void pins.refetch()}>Retry</Button></p>}
      {!pins.isPending && !pins.isError && pins.data?.ok === false && <p className="usage-note" role="alert">{unavailableReason(pins.data.reason)} <Button size="sm" variant="ghost" onClick={() => void pins.refetch()}>Retry</Button></p>}
      {!pins.isPending && !pins.isError && pins.data?.ok !== false && (pins.data?.items?.length ?? 0) === 0 && <EmptyState icon="pin" title="No pinned sessions yet." description="Pin a session or an agent subtree from its inspector." />}
      {pins.data?.evidence?.status === "partial" && <div className="usage-inspection-partial" role="alert"><span>Some pinned records are unavailable.</span>{pins.data.evidence.notices.map((notice, index) => <span key={`${notice}-${index}`}>{notice}</span>)}</div>}
      <div className="usage-pinned-list" role="list">
        {(pins.data?.items ?? []).map((pin) => { const breadcrumb = pin.breadcrumb ?? []; const isAgent = pin.root_type === "agent" || !!pin.run_id; const label = isAgent ? (breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 1].label : `Agent · ${pin.run_id?.slice(0, 8) ?? "selected"}`) : "Pinned session"; return <article key={`${pin.harness}:${pin.session_id}:${pin.run_id ?? "session"}`} className="usage-pinned-item" role="listitem">
          <div><strong>{label}</strong><span className="usage-note"> · {pin.harness} · {isAgent ? "agent subtree" : "session"} · {pin.status ?? "available"}</span>{pin.scopes && <span className="usage-pinned-stats">{" "}Own {tokenLabel(pin.scopes.own.tokens)} · Subtree {tokenLabel(pin.scopes.subtree.tokens)}</span>}</div>
          {breadcrumb.length > 0 && <nav className="usage-pinned-breadcrumb" aria-label="Pinned session breadcrumb">{breadcrumb.map((crumb, index) => <span key={`${crumb.label}-${index}`} className={crumb.status === "unavailable" ? "is-unavailable" : undefined}>{crumb.label}</span>)}{isAgent && <Button size="sm" variant="ghost" onClick={() => navigate(`/usage/session/${encodeURIComponent(pin.root_session_id)}?harness=${encodeURIComponent(pin.harness)}`, fromNav(usageBackTarget()))}>Open parent</Button>}</nav>}
          {breadcrumb.some((crumb) => crumb.status === "unavailable") && <p className="usage-note">Parent session unavailable; this agent pin remains readable.</p>}
          <div className="usage-pinned-actions"><Button size="sm" variant="soft" onClick={() => navigate(`/usage/session/${encodeURIComponent(pin.root_session_id)}?harness=${encodeURIComponent(pin.harness)}${pin.run_id ? `&run=${encodeURIComponent(pin.run_id)}` : ""}`, fromNav(usageBackTarget()))}>Open</Button><Button size="sm" variant="ghost" icon="pin" title="Unpin" aria-label="Unpin session" busy={pins.isMutating} onClick={() => pins.mutate({ action: "remove", harness: pin.harness, sessionId: pin.root_session_id, runId: pin.run_id })} /></div>
        </article>; })}
      </div>
      {pins.mutation.isError && <p className="usage-note" role="alert">Could not update the pin. Try again.</p>}
    </div>
  </>;
}

function tokenLabel(tokens: InspectionTokens) {
  if (tokens.total == null || tokens.status !== "available") return tokens.status === "partial" && tokens.total != null ? `${tokens.total.toLocaleString()} · partial` : "unavailable";
  return tokens.total.toLocaleString();
}
