import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { equipReferencedSkillOnly } from "@/hooks/useEquip";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import { errorDetail } from "@/lib/cliOutput";
import type { MissingRef } from "@/lib/syncFreshness";
import type { Registry } from "@/types";

export function MissingSkillsReview({ projectName, registry, missingRefs, equipped }: {
  projectName: string;
  registry: Registry;
  missingRefs: MissingRef[];
  equipped: string[];
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [completed, setCompleted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // The sync report supplies the reference edges. Live equip state can make
  // an old finding ineligible, but never invents a new reference.
  const names = [...new Set(missingRefs.flatMap((record) => record.refs))].sort((a, b) => a.localeCompare(b));
  function unavailable(name: string) {
    if (completed.includes(name) || equipped.includes(name)) return "Already equipped";
    if (!registry.skills[name]) return "No longer in the library. Sync to refresh this list.";
    return null;
  }
  const chosen = names.filter((name) => selected.includes(name) && !unavailable(name));
  const available = names.filter((name) => !unavailable(name));

  function review() {
    setSelected([]);
    setCompleted([]);
    setError(null);
    setOpen(true);
  }

  async function confirm() {
    if (writing.current || chosen.length === 0) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    let current = "";
    let count = 0;
    try {
      await trackProcess({ title: `Equipping ${chosen.length} on ${projectName}…`, kind: "batch" }, async () => {
        for (const name of chosen) {
          current = name;
          await equipReferencedSkillOnly(name, projectName);
          count += 1;
          setCompleted((prev) => [...prev, name]);
          setSelected((prev) => prev.filter((item) => item !== name));
        }
      });
      toast.success(`Equipped ${count} ${count === 1 ? "skill" : "skills"} on ${projectName}`);
      setOpen(false);
    } catch (err) {
      setError(`Couldn't finish equipping ${current}. ${count} ${count === 1 ? "skill was" : "skills were"} equipped. ${errorDetail(err).headline} Review the remaining selection and try again.`);
    } finally {
      try {
        await invalidateRegistry(client);
      } finally {
        writing.current = false;
        setBusy(false);
      }
    }
  }

  return <>
    {names.length > 0 && <div className="missing-refs-banner" role="status">
      <Icon name="warning" size={14} />
      <span><strong>{names.length} referenced {names.length === 1 ? "skill is" : "skills are"} missing</strong> from this project's loadout.</span>
      <Button variant="ghost" size="sm" className="missing-refs-link" onClick={review}>Review missing skills</Button>
    </div>}
    <ConfirmDialog
      open={open}
      onClose={() => { if (!writing.current) setOpen(false); }}
      onConfirm={() => void confirm()}
      title="Missing skills"
      width={640}
      busy={busy}
      confirmDisabled={chosen.length === 0}
      confirmLabel={busy ? "Equipping…" : `Equip ${chosen.length} selected ${chosen.length === 1 ? "skill" : "skills"}`}
      body={<div className="missing-skills-review">
        <p>Skills in <strong>{projectName}</strong> mention the skills below, which were missing at the last sync. Choose which ones to add to this project's loadout.</p>
        <Toggle
          label="Select all available skills"
          checked={available.length > 0 && chosen.length === available.length}
          indeterminate={chosen.length > 0 && chosen.length < available.length}
          disabled={busy || available.length === 0}
          onChange={(checked) => setSelected(checked ? available : [])}
        />
        <div className="missing-skills-list">
          {names.map((name) => {
            const reason = unavailable(name);
            const sources = [...new Set(missingRefs.filter((record) => record.refs.includes(name)).map((record) => record.skill))];
            return <div className="missing-skills-row" key={name}>
              <Toggle
                ariaLabel={`Select ${name}`}
                checked={chosen.includes(name)}
                disabled={busy || !!reason}
                onChange={(checked) => setSelected((prev) => checked ? [...prev, name] : prev.filter((item) => item !== name))}
                label={<span className="missing-skills-detail">
                  <strong className="missing-skills-name">{name}</strong>
                  {registry.skills[name]?.description && <span>{registry.skills[name].description}</span>}
                  <span className="missing-skills-sources">
                    {sources.map((source) => {
                      const path = registry.skills[source]?.source?.replace(/\/+$/, "");
                      return <span className="missing-skills-source" key={source}>
                        <span>Referenced by <strong>{source}</strong></span>
                        <span className="missing-skills-source-path">{path ? `${path}/SKILL.md` : "Source path unavailable"}</span>
                      </span>;
                    })}
                  </span>
                  {reason && <span>{reason}</span>}
                </span>}
              />
            </div>;
          })}
        </div>
        <p>Only selected skills will be equipped. Their own references and companion agents, hooks, and permissions will not be added. You can unequip them from the loadout later.</p>
        {error && <p role="alert" className="missing-skills-error">{error}</p>}
      </div>}
    />
  </>;
}
