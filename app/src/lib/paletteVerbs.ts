import { invoke } from "@/lib/ipc";
import type { Registry } from "@/types";
import type { UndoableAction } from "@/hooks/useUndoableAction";
import { buildSkillProjectTargets } from "@/hooks/useEquipTargets";

/**
 * Palette verbs with arguments (ux-command-layer D3). A verb is a palette entry
 * whose selection pushes one or more argument stages instead of navigating; its
 * `run` fires once every argument is picked. Argument stages reuse the palette
 * option-list (or a validated text input) — no second list widget.
 */
export interface PaletteOption {
  id: string;
  name: string;
  icon?: string;
  hint?: string;
}

/** The data an option builder reads (the resolved registry). */
export interface RegistryView {
  registry: Registry;
}

export interface PaletteArgSpec {
  name: string;
  /** Crumb + stage header, e.g. "Pick a skill". */
  title: string;
  kind: "list" | "text";
  /** For kind:"list": options derived from the registry + prior picks. */
  options?: (picked: Record<string, string>, data: RegistryView) => PaletteOption[];
  placeholder?: string;
}

export interface PaletteRunCtx {
  navigate: (to: string) => void;
  /** Route the terminal action through the undo layer (D4). */
  runUndoable: (a: UndoableAction) => Promise<void>;
}

export interface PaletteVerb {
  id: string;
  /** Trailing "…" signals the entry takes arguments. */
  label: string;
  icon: string;
  args: PaletteArgSpec[];
  run: (picked: Record<string, string>, ctx: PaletteRunCtx) => Promise<void>;
}

/** Slug validation shared by every `kind:"text"` argument stage. */
export const SLUG_RE = /^[a-z0-9-]+$/;

interface HubResult {
  success: boolean;
  output: string;
}

async function hubCmd(args: string[]): Promise<void> {
  const res = await invoke<HubResult>("hub_cmd", { args });
  if (!res.success) throw new Error(res.output || "command failed");
}

const EQUIP_INVALIDATE = [["registry"], ["syncReport"]];

function skillOptions(_picked: Record<string, string>, { registry }: RegistryView): PaletteOption[] {
  return Object.entries(registry.skills ?? {}).map(([name, s]) => ({
    id: name,
    name,
    icon: s.type === "mcp-server" ? "mcp" : "skill",
    hint: s.scope,
  }));
}

function bundleOptions(_picked: Record<string, string>, { registry }: RegistryView): PaletteOption[] {
  return Object.entries(registry.bundles ?? {}).map(([name, b]) => ({
    id: name,
    name,
    icon: "bundle",
    hint: `${b.skills?.length ?? 0} skills`,
  }));
}

function projectOptions(_picked: Record<string, string>, { registry }: RegistryView): PaletteOption[] {
  return Object.keys(registry.projects ?? {}).map((name) => ({
    id: name,
    name,
    icon: "project",
  }));
}

/** Projects with honest equip-state hints for the chosen skill (D3). */
function equipProjectOptions(
  picked: Record<string, string>,
  { registry }: RegistryView,
): PaletteOption[] {
  const skill = picked.skill;
  const targets = skill ? buildSkillProjectTargets(skill, registry) : [];
  return targets.map((t) => ({
    id: t.id,
    name: t.name,
    icon: "project",
    hint:
      t.state === "on" ? "equipped" : t.state === "via-bundle" ? "via bundle" : "",
  }));
}

const TAB_ROUTE: Record<string, string> = {
  loadout: "loadout",
  permissions: "permissions",
  subagents: "subagents",
  "agent-docs": "agent-docs",
};

export const PALETTE_VERBS: PaletteVerb[] = [
  {
    id: "equip-skill",
    label: "Equip skill…",
    icon: "equip",
    args: [
      { name: "skill", title: "Pick a skill", kind: "list", options: skillOptions },
      {
        name: "project",
        title: "Pick a project",
        kind: "list",
        options: equipProjectOptions,
      },
    ],
    run: async ({ skill, project }, ctx) => {
      await ctx.runUndoable({
        do: () => hubCmd(["enable", skill, "--project", project]),
        undo: () => hubCmd(["disable", skill, "--project", project]),
        label: `Equipped ${skill} on ${project}`,
        invalidate: EQUIP_INVALIDATE,
      });
    },
  },
  {
    id: "apply-bundle",
    label: "Apply bundle…",
    icon: "bundle",
    args: [
      { name: "bundle", title: "Pick a bundle", kind: "list", options: bundleOptions },
      { name: "project", title: "Pick a project", kind: "list", options: projectOptions },
    ],
    run: async ({ bundle, project }, ctx) => {
      await ctx.runUndoable({
        do: () => hubCmd(["bundle", "apply", bundle, "--project", project]),
        undo: () => hubCmd(["bundle", "remove", bundle, "--project", project]),
        label: `Applied ${bundle} to ${project}`,
        invalidate: EQUIP_INVALIDATE,
      });
    },
  },
  {
    id: "new-snippet",
    label: "New snippet…",
    icon: "snippet",
    args: [
      {
        name: "name",
        title: "Snippet name",
        kind: "text",
        placeholder: "my-snippet-name",
      },
    ],
    run: async ({ name }, ctx) => {
      ctx.navigate(`/snippets?new=${encodeURIComponent(name)}`);
    },
  },
  {
    id: "open-project-tab",
    label: "Open project…",
    icon: "project",
    args: [
      { name: "project", title: "Pick a project", kind: "list", options: projectOptions },
      {
        name: "tab",
        title: "Pick a tab",
        kind: "list",
        options: () => [
          { id: "loadout", name: "Loadout", icon: "plug" },
          { id: "permissions", name: "Permissions", icon: "shield" },
          { id: "subagents", name: "Sub-Agents", icon: "plug" },
          { id: "agent-docs", name: "Agent Docs", icon: "doc" },
        ],
      },
    ],
    run: async ({ project, tab }, ctx) => {
      const t = TAB_ROUTE[tab] ?? "loadout";
      ctx.navigate(`/project/${encodeURIComponent(project)}?tab=${t}`);
    },
  },
];
