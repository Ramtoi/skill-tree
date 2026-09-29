import { EmptyState } from "@/components/EmptyState";
import { Tag } from "@/components/Tag";
import type { InspectionChange } from "@/features/usage/usageInspectionTypes";

export function UsageSessionChanges({ changes, onBody }: { changes: InspectionChange[]; onBody?: (bodyId: string, label?: string) => void }) {
  if (changes.length === 0) return <EmptyState icon="check" title="No captured changes for this session." />;
  return <div className="usage-inspection-changes" role="list" aria-label="Captured changes">
    {changes.map((change) => (
      <article key={change.id} className="usage-inspection-change" role="listitem">
        <div className="usage-inspection-change-head">
          <strong>{change.kind.replace(/_/g, " ")}</strong>
          <Tag size="sm" kind={change.attribution === "confirmed" ? "solid" : "outline"}>{change.attribution}</Tag>
        </div>
        <p className="usage-note">{change.source}{change.repository_id ? ` · ${change.repository_id}` : ""}</p>
        {change.revision_id && <code className="usage-inspection-revision">{change.revision_id}{change.base_id ? ` ← ${change.base_id}` : ""}</code>}
        {change.files.length > 0 ? <ul>{change.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <p className="usage-note">No file list was retained.</p>}
        {change.patch?.body_id && (change.patch.status === "available" || change.patch.status === "external_file") && <button type="button" className="usage-inline-link" onClick={() => onBody?.(change.patch!.body_id!, "Captured patch")}>Open retained patch body</button>}
        {change.patch?.status === "unavailable" && <p className="usage-note">Patch body unavailable; the change record is retained.</p>}
        {change.patch?.status === "truncated" && <p className="usage-note">Patch body was truncated by the source.</p>}
        {change.patch?.status === "pruned" && <p className="usage-note">Patch pruned{change.patch.pruned_at ? ` · ${new Date(change.patch.pruned_at).toLocaleDateString()}` : ""}; the change record is retained.</p>}
      </article>
    ))}
  </div>;
}
