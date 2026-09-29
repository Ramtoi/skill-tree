/* Pointer regions have keyboard move controls; native controls are excluded. */
/* eslint-disable jsx-a11y/no-static-element-interactions */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { InlineName } from "@/components/InlineName";
import { Select } from "@/components/Select";
import { bundleSections, LOOSE_SECTION, type PlaybookOp } from "@/lib/bundlePlaybook";
import { useHoldDrag } from "@/hooks/useHoldDrag";
import { useBundlePlaybook } from "@/hooks/useBundlePlaybook";
import type { PlaybookSection, Skill } from "@/types";
import type { BundleLensState } from "./BundleLens";

type Moving = { kind: "skill"; name: string } | { kind: "section"; id: string };

function Guidance({ section, save }: { section: PlaybookSection; save: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState(section.guidance ?? "");
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(section.guidance ?? ""); }, [section.guidance]);
  return <input className="playbook-guidance" value={draft} maxLength={2000}
    aria-label={`Guidance for ${section.title}`} placeholder="Add guidance…"
    onFocus={() => { focused.current = true; }} onChange={(e) => setDraft(e.target.value)}
    onBlur={() => { focused.current = false; if (cancelled.current) { cancelled.current = false; return; } if (draft !== (section.guidance ?? "")) void save(draft).catch(() => {}); }}
    onKeyDown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") { cancelled.current = true; setDraft(section.guidance ?? ""); e.currentTarget.blur(); }
    }} />;
}

function SectionActions({ section, children, remove }: {
  section: PlaybookSection; children: ReactNode; remove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (confirming) root.current?.querySelector<HTMLButtonElement>(".playbook-delete-cancel")?.focus();
    else if (restoreFocus.current) {
      root.current?.querySelector<HTMLButtonElement>(".playbook-delete-trigger")?.focus();
      restoreFocus.current = false;
    }
  }, [confirming]);
  const cancel = () => { if (!deleting) { restoreFocus.current = true; setConfirming(false); } };
  const commit = () => {
    if (deleting) return;
    setDeleting(true);
    void remove().catch(() => {}).finally(() => setDeleting(false));
  };
  return <div ref={root} className="playbook-section-actions" data-open={confirming || undefined}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => { if (confirming && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    {confirming ? <div key="confirm" className="playbook-section-action-state playbook-delete-confirm" role="group" aria-label={`Delete section ${section.title}`}>
      <span className="playbook-delete-copy" role="status">Delete section? <span>{section.skills.length > 0 && <>{section.skills.length} {section.skills.length === 1 ? "skill moves" : "skills move"} to Unsectioned. </>}{section.guidance?.trim() && "Guidance is removed."}</span></span>
      <Button size="sm" className="playbook-delete-cancel" disabled={deleting} onClick={cancel}>Cancel</Button>
      <Button size="sm" variant="danger" busy={deleting} onClick={commit}>Delete</Button>
    </div> : <div key="actions" className="playbook-section-action-state">
      {children}
      <Button size="sm" icon="trash" className="playbook-delete-trigger" busy={deleting} title={`Delete section ${section.title}; keep its skills`}
        onClick={() => { if (section.skills.length || section.guidance?.trim()) setConfirming(true); else commit(); }} />
    </div>}
  </div>;
}

export function BundlePlaybook({ lens, visible, renderSkill }: {
  lens: BundleLensState;
  visible: Array<[string, Skill]>;
  renderSkill: (name: string, skill: Skill, key: string) => ReactNode;
}) {
  const sections = bundleSections(lens.bundle);
  const shown = new Map(visible);
  const { mutate, pending } = useBundlePlaybook(lens.bundleName, lens.enqueueWrite);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const [controls, setControls] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusTarget, setFocusTarget] = useState<{ name: string; section?: string } | null>(null);
  const focusRow = (name: string, section?: string) => setFocusTarget({ name, section });
  useLayoutEffect(() => {
    if (!focusTarget) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>(".playbook-skill");
    const row = [...(rows ?? [])].find((node) => node.dataset.skillName === focusTarget.name);
    // Query subscribers may render the new layout after the mutation promise
    // resolves. Wait for the destination, otherwise focus the soon-removed row.
    if (!row || (focusTarget.section && row.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId !== focusTarget.section)) return;
    row.querySelector<HTMLElement>(".lib-nav-row")?.focus();
    setFocusTarget(null);
  }, [focusTarget, lens.bundle.playbook]);
  useEffect(() => {
    if (controls) rootRef.current?.querySelector<HTMLElement>(".playbook-move-controls button:not([disabled])")?.focus();
  }, [controls]);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const apply = (op: PlaybookOp, label: string) => mutate(op, label).then(() => setAnnouncement(label));
  const act = (op: PlaybookOp, label: string) => { void apply(op, label).catch(() => {}); };
  const labelOf = (s: PlaybookSection) => s.id === LOOSE_SECTION ? "Unsectioned" : s.title;
  function targetAt(item: Moving, point: { x: number; y: number }): { section: PlaybookSection; before?: string; marker?: string } | null {
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || !rootRef.current?.contains(hit)) return null;
    const sectionId = hit.closest<HTMLElement>(".playbook-section")?.dataset.sectionId;
    const section = sections.find((s) => s.id === sectionId);
    if (!section) return null;
    if (item.kind === "section") {
      const bounds = hit.closest<HTMLElement>(".playbook-section")!.getBoundingClientRect();
      const after = point.y > bounds.top + bounds.height / 2;
      return { section: after ? sections[sections.indexOf(section) + 1] ?? section : section };
    }
    const row = hit.closest<HTMLElement>(".playbook-skill");
    const name = row?.dataset.skillName;
    if (!row || !name) return { section };
    const rect = row.getBoundingClientRect();
    const above = point.y < rect.top + rect.height / 2;
    const following = section.skills.slice(section.skills.indexOf(name) + 1);
    // The persisted insertion includes hidden members; the indicator must
    // still sit beside a visible row when the list is filtered.
    return { section, before: above ? name : following[0], marker: above ? name : following.find((next) => shown.has(next)) };
  }
  const drag = useHoldDrag<Moving>({
    onStart: (item) => { setMoving(item); setControls(null); setAnnouncement("Picked up. Move to a position, or press Escape to cancel."); },
    onMove: (item, point) => {
      const target = targetAt(item, point);
      setDropAt(target ? item.kind === "section" ? target.section.id : `${target.section.id}:${target.marker ?? "end"}` : null);
    },
    onEnd: (item, point) => {
      const target = point ? targetAt(item, point) : null;
      if (target) {
        if (item.kind === "skill") void apply({ kind: "moveSkill", name: item.name, section: target.section.id, before: target.before }, `Moved ${item.name} to ${labelOf(target.section)}`).then(() => focusRow(item.name, target.section.id)).catch(() => {});
        else act({ kind: "moveSection", id: item.id, before: target.section.id }, "Reordered sections");
      } else setAnnouncement("Move cancelled");
      setMoving(null); setDropAt(null);
    },
  });
  return <div ref={rootRef} className="bundle-playbook lib-list" data-dragging={!!moving || undefined} onClickCapture={drag.onClickCapture} onDragStart={(event) => event.preventDefault()}>
    <div className="playbook-toolbar" onKeyDown={(e) => e.stopPropagation()}>
      <span className="text-dim">{pending ? "Saving arrangement…" : moving ? "Release to place · Esc to cancel" : "Hold a row to move · Alt+M for move options"}</span>
      <span ref={(node) => { addRef.current = node?.querySelector("button") ?? null; }}>
        <Button size="sm" icon="plus" onClick={() => act({ kind: "addSection", section: { id: crypto.randomUUID(), title: "New section", guidance: "", skills: [] } }, "Added section")}>Add section</Button>
      </span>
    </div>
    <span className="sr-only" role="status">{announcement}</span>
    {lens.memberNames.length === 0 && <div className="playbook-empty"><strong>Empty bundle</strong><span>{lens.isLinked ? `${lens.sourceName} has no available skills yet.` : "Add skills from the header, or create sections first."}</span></div>}
    {sections.map((section, sectionIndex) => {
      const loose = section.id === LOOSE_SECTION;
      const items = section.skills.filter((name) => shown.has(name));
      const showHeader = !loose || sections.length > 1;
      return <section key={section.id} className="playbook-section" data-section-id={section.id} aria-label={labelOf(section)}
        data-drop-section={moving?.kind === "section" && dropAt === section.id || undefined}>
        {showHeader && <div className="playbook-section-heading" onPointerDown={(event) => { if (!loose) drag.onPointerDown(event, { kind: "section", id: section.id }); }} data-moving={moving?.kind === "section" && moving.id === section.id || undefined} onKeyDown={(e) => e.stopPropagation()}>
          {loose ? <span className="playbook-section-title">Unsectioned</span> : <InlineName value={section.title} label="Section" validate={(name) => !name || name.length > 200 ? "Use a name between 1 and 200 characters" : null}
            onSave={(title) => apply({ kind: "editSection", id: section.id, field: "title", value: title }, "Renamed section")} />}
          <span className="text-dim">{items.length === section.skills.length ? items.length : `${items.length} / ${section.skills.length}`}</span>
          {!loose && <SectionActions section={section} remove={() => apply({ kind: "removeSection", id: section.id }, "Deleted section; kept its skills").then(() => { addRef.current?.focus(); })}>
            <Button size="sm" icon="chevron-up" title={`Move ${section.title} up`} disabled={sectionIndex === 0} onClick={() => act({ kind: "moveSection", id: section.id, before: sections[sectionIndex - 1]?.id }, "Moved section up")} />
            <Button size="sm" icon="chevron-down" title={`Move ${section.title} down`} disabled={sectionIndex >= sections.length - 2} onClick={() => act({ kind: "moveSection", id: section.id, before: sections[sectionIndex + 2]?.id }, "Moved section down")} />
          </SectionActions>}
        </div>}
        {!loose && <Guidance section={section} save={(value) => apply({ kind: "editSection", id: section.id, field: "guidance", value }, "Updated guidance")} />}
        {items.map((name) => {
          const index = section.skills.indexOf(name);
          return <div key={name} className="playbook-skill" data-skill-name={name} data-moving={moving?.kind === "skill" && moving.name === name || undefined} data-drop-before={dropAt === `${section.id}:${name}` || undefined}
            onPointerDown={(event) => drag.onPointerDown(event, { kind: "skill", name })}
            onKeyDownCapture={(event) => {
              if (!event.altKey || (event.target as Element).closest("button, input, textarea, select, [role=combobox]")) return;
              if (event.code === "KeyM" || event.key.toLowerCase() === "m") { event.preventDefault(); event.stopPropagation(); setControls(controls === name ? null : name); }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault(); event.stopPropagation();
                if (event.key === "ArrowUp" && index > 0) act({ kind: "moveSkill", name, section: section.id, before: section.skills[index - 1] }, `Moved ${name} up`);
                if (event.key === "ArrowDown" && index < section.skills.length - 1) act({ kind: "moveSkill", name, section: section.id, before: section.skills[index + 2] }, `Moved ${name} down`);
              }
            }}>
            {renderSkill(name, shown.get(name)!, `${shown.get(name)!.type === "mcp-server" ? "mcp" : "skill"}:${name}`)}
            {controls === name && <div className="playbook-move-controls" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { setControls(null); focusRow(name); } }}>
              <span>Move {name}</span>
              <Button size="sm" icon="chevron-up" disabled={index === 0} onClick={() => act({ kind: "moveSkill", name, section: section.id, before: section.skills[index - 1] }, `Moved ${name} up`)}>Up</Button>
              <Button size="sm" icon="chevron-down" disabled={index === section.skills.length - 1} onClick={() => act({ kind: "moveSkill", name, section: section.id, before: section.skills[index + 2] }, `Moved ${name} down`)}>Down</Button>
              <Select label={`Section for ${name}`} value={section.id} options={sections.map((s) => ({ value: s.id, label: labelOf(s) }))}
                onChange={(id) => { void apply({ kind: "moveSkill", name, section: id }, `Moved ${name}`).then(() => { setControls(null); focusRow(name, id); }).catch(() => focusRow(name, section.id)); }} />
              <Button size="sm" onClick={() => { setControls(null); focusRow(name); }}>Done</Button>
            </div>}
          </div>;
        })}
        <div className="playbook-drop-end" data-active={dropAt === `${section.id}:end` || undefined}>
          {items.length === 0 ? (section.skills.length ? "No matching skills in this section" : "Drop skills here") : ""}
        </div>
      </section>;
    })}
  </div>;
}
