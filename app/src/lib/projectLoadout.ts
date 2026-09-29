import type { Project, Registry } from "@/types";
import { bundleSections, LOOSE_SECTION } from "./bundlePlaybook";
import {
  directOnly,
  getBundleScope,
  resolveActiveSkills,
} from "./resolveActiveSkills";

export type SectionRef =
  | { kind: "bundle"; bundle: string; section: string }
  | { kind: "direct" };
export interface LoadoutSection {
  ref: SectionRef;
  title: string;
  guidance?: string;
  scope: "project" | "global";
  members: string[];
}
export function sectionKey(ref: SectionRef): string {
  return JSON.stringify(
    ref.kind === "direct" ? ["direct"] : ["bundle", ref.bundle, ref.section],
  );
}
export function occurrenceKey(ref: SectionRef, name: string): string {
  return JSON.stringify([sectionKey(ref), name]);
}
/** Presentation only. Source membership and member order never change here. */
export function projectLoadout(project: Project, registry: Registry) {
  const sources = [
    ...new Set([
      ...project.bundles.filter(
        (name) =>
          registry.bundles[name] &&
          getBundleScope(registry.bundles[name]) !== "global",
      ),
      ...Object.keys(registry.bundles).filter(
        (name) => getBundleScope(registry.bundles[name]) === "global",
      ),
    ]),
  ];
  const sections: LoadoutSection[] = sources.flatMap((bundle) =>
    bundleSections(registry.bundles[bundle])
      .filter(
        (section) => section.id !== LOOSE_SECTION || section.skills.length > 0,
      )
      .map((section) => ({
        ref: { kind: "bundle" as const, bundle, section: section.id },
        title: section.title || "Other members",
        guidance: section.guidance,
        scope:
          getBundleScope(registry.bundles[bundle]) === "global"
            ? ("global" as const)
            : ("project" as const),
        members: section.skills,
      })),
  );
  const direct = [...new Set(directOnly(project, registry))].reverse();
  if (direct.length)
    sections.push({
      ref: { kind: "direct" },
      title: "Directly equipped",
      scope: "project",
      members: direct,
    });
  const members = resolveActiveSkills(project, registry);
  const mcp = members.filter(
    (name) => registry.skills[name]?.type === "mcp-server",
  );
  const skills = members.filter(
    (name) =>
      registry.skills[name] && registry.skills[name].type !== "mcp-server",
  );
  return {
    sections,
    members,
    skills,
    mcp,
    unresolved: members.filter((name) => !registry.skills[name]),
    sources,
  };
}
