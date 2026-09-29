import type { Bundle, PlaybookSection } from "@/types";

export const LOOSE_SECTION = "unsectioned";

/** Membership wins over presentation, including after a source refresh. */
export function bundleSections(bundle: Pick<Bundle, "skills" | "playbook">): PlaybookSection[] {
  const members = new Set(bundle.skills);
  const seen = new Set<string>();
  const ids = new Set<string>();
  const sections: PlaybookSection[] = [];
  for (const section of Array.isArray(bundle.playbook) ? bundle.playbook : []) {
    if (!section || typeof section !== "object" || typeof section.id !== "string" || !section.id || typeof section.title !== "string" || !Array.isArray(section.skills)) continue;
    if (ids.has(section.id)) continue;
    ids.add(section.id);
    sections.push({ ...section, title: section.id === LOOSE_SECTION ? "" : section.title,
      guidance: typeof section.guidance === "string" ? section.guidance : undefined,
      skills: section.skills.filter((name) => {
      if (!members.has(name) || seen.has(name)) return false;
      seen.add(name);
      return true;
    }) });
  }
  const loose = sections.find((s) => s.id === LOOSE_SECTION)
    ?? { id: LOOSE_SECTION, title: "", skills: [] };
  loose.skills.push(...bundle.skills.filter((name) => !seen.has(name)));
  return [...sections.filter((s) => s.id !== LOOSE_SECTION), loose];
}

export type PlaybookOp =
  | { kind: "moveSkill"; name: string; section: string; before?: string }
  | { kind: "moveSection"; id: string; before?: string }
  | { kind: "addSection"; section: PlaybookSection; before?: string }
  | { kind: "removeSection"; id: string }
  | { kind: "editSection"; id: string; field: "title" | "guidance"; value: string; expected?: string };

export function changePlaybook(bundle: Pick<Bundle, "skills" | "playbook">, op: PlaybookOp): {
  sections: PlaybookSection[]; inverse?: PlaybookOp;
} {
  const sections = bundleSections(bundle);
  const loose = sections.find((s) => s.id === LOOSE_SECTION)!;
  if (op.kind === "moveSkill") {
    const from = sections.find((s) => s.skills.includes(op.name));
    const to = sections.find((s) => s.id === op.section);
    if (!from || !to || op.before === op.name) return { sections };
    const index = from.skills.indexOf(op.name);
    const inverse: PlaybookOp = { kind: "moveSkill", name: op.name, section: from.id, before: from.skills[index + 1] };
    from.skills.splice(index, 1);
    const target = op.before ? to.skills.indexOf(op.before) : -1;
    to.skills.splice(target < 0 ? to.skills.length : target, 0, op.name);
    return { sections, inverse };
  }
  if (op.kind === "addSection") {
    if (sections.some((s) => s.id === op.section.id)) return { sections };
    // Undo of deletion only reclaims members still loose, never later moves.
    const restored = op.section.skills.filter((name) => loose.skills.includes(name));
    loose.skills = loose.skills.filter((name) => !restored.includes(name));
    const index = sections.findIndex((s) => s.id === (op.before ?? LOOSE_SECTION));
    sections.splice(index < 0 ? sections.length - 1 : index, 0, { ...op.section, skills: restored });
    return { sections, inverse: { kind: "removeSection", id: op.section.id } };
  }
  const index = sections.findIndex((s) => s.id === op.id);
  const section = sections[index];
  if (!section || section.id === LOOSE_SECTION) return { sections };
  if (op.kind === "editSection") {
    if (op.expected !== undefined && (section[op.field] ?? "") !== op.expected) {
      throw new Error("This section was edited again. Undo the newer edit first.");
    }
    const inverse: PlaybookOp = { ...op, value: section[op.field] ?? "", expected: op.value };
    section[op.field] = op.value;
    return { sections, inverse };
  }
  const before = sections[index + 1]?.id;
  if (op.kind === "removeSection") {
    sections.splice(index, 1);
    loose.skills.push(...section.skills);
    return { sections, inverse: { kind: "addSection", section, before } };
  }
  if (op.before === op.id) return { sections };
  sections.splice(index, 1);
  const target = sections.findIndex((s) => s.id === (op.before ?? LOOSE_SECTION));
  sections.splice(target < 0 ? sections.length - 1 : target, 0, section);
  return { sections, inverse: { kind: "moveSection", id: op.id, before } };
}
