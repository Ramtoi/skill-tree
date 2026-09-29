import { sectionKey, type SectionRef } from "./projectLoadout";
export const orderStorageKey = (path: string) =>
  `st:project-loadout-order:v1:${path}`;
export function readSectionOrder(raw: string | null): SectionRef[] | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("sections" in value) ||
      !Array.isArray(value.sections)
    )
      return null;
    if (
      !value.sections.every(
        (ref: unknown) =>
          ref &&
          typeof ref === "object" &&
          "kind" in ref &&
          (ref.kind === "direct" ||
            (ref.kind === "bundle" &&
              "bundle" in ref &&
              typeof ref.bundle === "string" &&
              "section" in ref &&
              typeof ref.section === "string")),
      )
    )
      return null;
    return value.sections as SectionRef[];
  } catch {
    return null;
  }
}
export function reconcileOrder(
  saved: readonly SectionRef[] | null,
  canonical: readonly SectionRef[],
): SectionRef[] {
  const byKey = new Map(canonical.map((ref) => [sectionKey(ref), ref]));
  const result: SectionRef[] = [];
  for (const ref of [...(saved ?? []), ...canonical]) {
    const key = sectionKey(ref);
    const current = byKey.get(key);
    if (current) {
      result.push(current);
      byKey.delete(key);
    }
  }
  return result;
}
export function moveSection(
  order: readonly SectionRef[],
  key: string,
  before?: string,
): SectionRef[] {
  const ref = order.find((item) => sectionKey(item) === key);
  if (!ref || key === before) return [...order];
  const next = order.filter((item) => sectionKey(item) !== key);
  const index = before
    ? next.findIndex((item) => sectionKey(item) === before)
    : -1;
  next.splice(index < 0 ? next.length : index, 0, ref);
  return next;
}
