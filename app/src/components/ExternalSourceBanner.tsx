import { useState, type FormEvent } from "react";
import { invoke } from "@/lib/ipc";
import type { Skill, SourceView } from "@/types";
import { Button } from "./Button";
import { SourceChip, SourceStatusDot } from "./SourceChip";
import { useToast } from "./Toast";
import { queryClient } from "@/lib/queryClient";

const SLUG_RE = /^[a-z0-9-]+$/;

export interface ExternalSourceBannerProps {
  skillName: string;
  skill: Skill;
  source: SourceView;
  onDuplicated?: (newName: string) => void;
}

/** Banner shown above the Skill Editor body when a skill is managed by an
 *  external source or the starter pack. Explains that source sync owns the
 *  files and offers Check / Sync / Duplicate-as-local actions. */
export function ExternalSourceBanner({
  skillName,
  skill,
  source,
  onDuplicated,
}: ExternalSourceBannerProps) {
  const toast = useToast();
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [newName, setNewName] = useState(`${skillName}-local`);
  const [working, setWorking] = useState(false);
  const isStarter = source.type === "starter" || skill.managed === "starter";
  const isExternal = source.type === "git" || skill.managed === "external";
  if (!isExternal && !isStarter) return null;

  const accent = isStarter ? "var(--amber)" : "var(--violet)";
  const title = isStarter
    ? "Managed by Starter Pack"
    : `Managed by external source · ${source.name}`;

  async function runHub(args: string[]): Promise<string> {
    const res = await invoke<{ success: boolean; output: string }>("hub_cmd", { args });
    if (!res.success) throw new Error(res.output || "hub command failed");
    return res.output;
  }

  async function onCheck() {
    if (!isExternal) return;
    setWorking(true);
    try {
      await runHub(["source", "check", source.id, "--json"]);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast.success(`Checked ${source.name}`);
    } catch (err) {
      toast.error("Couldn't check source", String(err));
    } finally {
      setWorking(false);
    }
  }

  async function onSync() {
    if (!isExternal) return;
    setWorking(true);
    try {
      await runHub(["source", "sync", source.id, "--json"]);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast.success(`Synced ${source.name}`);
    } catch (err) {
      toast.error("Couldn't sync source", String(err));
    } finally {
      setWorking(false);
    }
  }

  async function onDuplicate(e: FormEvent) {
    e.preventDefault();
    if (!SLUG_RE.test(newName)) {
      toast.error("Slug must be lowercase letters, numbers, and hyphens");
      return;
    }
    setWorking(true);
    try {
      await runHub(["source", "duplicate", skillName, "--as", newName, "--json"]);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      toast.success(`Duplicated as ${newName}`);
      setShowDuplicate(false);
      onDuplicated?.(newName);
    } catch (err) {
      toast.error("Couldn't duplicate source", String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      className="external-source-banner"
      data-source={source.id}
      data-managed={isStarter ? "starter" : "external"}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 12,
        padding: "10px 14px",
        marginBottom: 12,
        border: `1px solid color-mix(in oklab, ${accent} 35%, transparent)`,
        background: `color-mix(in oklab, ${accent} 8%, transparent)`,
        borderRadius: "var(--radius-sm, 6px)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SourceStatusDot status={source.status} accent={accent} />
          <strong style={{ fontFamily: "var(--font-mono)" }}>{title}</strong>
          <SourceChip compact source={source} />
        </div>
        {isExternal && source.type === "git" && (
          <div style={{ color: "var(--fg-mute)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {source.url ?? "—"}
            {source.branch ? ` · ${source.branch}` : ""}
            {source.path ? ` · /${source.path}` : ""}
            {source.current_ref ? ` · ${source.current_ref.slice(0, 7)}` : ""}
          </div>
        )}
        <div style={{ color: "var(--fg-mute)" }}>
          Content is read-only because source sync owns these files. Use{" "}
          <strong>Duplicate as local</strong> to make an editable copy in your data home.
        </div>
        {showDuplicate && (
          <form onSubmit={onDuplicate} style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              spellCheck={false}
              aria-label="New local skill slug"
              style={{
                flex: 1,
                padding: "4px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: "var(--bg-1)",
              }}
            />
            <Button variant="primary" type="submit" disabled={working}>
              {working ? "Duplicating…" : "Duplicate"}
            </Button>
            <Button variant="ghost" onClick={() => setShowDuplicate(false)} type="button">
              Cancel
            </Button>
          </form>
        )}
      </div>
      {!showDuplicate && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isExternal && (
            <>
              <Button variant="ghost" icon="fetch" onClick={onCheck} disabled={working} title="Check source for updates">
                Check
              </Button>
              {source.status === "update-available" && (
                <Button variant="primary" icon="apply" onClick={onSync} disabled={working}>
                  Sync update
                </Button>
              )}
            </>
          )}
          <Button variant="ghost" icon="duplicate" onClick={() => setShowDuplicate(true)} disabled={working}>
            Duplicate as local
          </Button>
        </div>
      )}
    </div>
  );
}
