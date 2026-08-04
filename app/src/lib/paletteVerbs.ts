import { invoke } from "@/lib/ipc";
import type { Registry } from "@/types";
import type { UndoableAction } from "@/hooks/useUndoableAction";
import type { HookRow } from "@/hooks/useHooks";
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

/** The data an option builder reads (the resolved registry + the hook library
 *  from `useHookList`, present when the palette host has loaded it). */
export interface RegistryView {
  registry: Registry;
  hooks?: HookRow[];
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

/** A consequence-gated confirm the palette surfaces before a terminal action
 *  (e.g. a machine-wide global hook attach). Mirrors the ConfirmDialog pattern
 *  used by PermissionsEditor's Codex-trust save-time confirm. */
export interface PaletteConfirm {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

export interface PaletteRunCtx {
  navigate: (to: string) => void;
  /** Route the terminal action through the undo layer (D4). */
  runUndoable: (a: UndoableAction) => Promise<void>;
  /** Surface a consequence confirm before committing the action. */
  confirm: (opts: PaletteConfirm) => void;
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

/** Attach/detach a hook to a scope through the same Tauri commands the useHooks
 *  layer uses (→ lib/ipc). `scope` is "global" or "project:<name>". */
async function hookScopeCmd(
  cmd: "hook_attach" | "hook_detach",
  name: string,
  scope: string,
): Promise<void> {
  const isGlobal = scope === "global";
  const project = isGlobal ? null : scope.replace(/^project:/, "");
  const res = await invoke<HubResult>(cmd, { name, global: isGlobal, project });
  if (!res.success) throw new Error(res.output || "command failed");
}

const EQUIP_INVALIDATE = [["registry"], ["syncReport"]];
const HOOK_INVALIDATE = [["hooks"], ["registry"], ["syncReport"]];

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

/** Every hook in the library (attach source list). */
function hookOptions(
  _picked: Record<string, string>,
  { hooks }: RegistryView,
): PaletteOption[] {
  return (hooks ?? []).map((h) => ({
    id: h.name,
    name: h.name,
    icon: "bolt",
    hint: h.event,
  }));
}

/** Scope options for ATTACH: global + every project (honest "attached" hints). */
function hookAttachScopeOptions(
  picked: Record<string, string>,
  { registry, hooks }: RegistryView,
): PaletteOption[] {
  const hook = (hooks ?? []).find((h) => h.name === picked.hook);
  const projects = Object.keys(registry.projects ?? {}).map((name) => ({
    id: `project:${name}`,
    name,
    icon: "project",
    hint: hook?.attached_projects.includes(name) ? "attached" : "",
  }));
  return [
    {
      id: "global",
      name: "Global — all sessions",
      icon: "globe",
      hint: hook?.attached_global ? "attached" : "every directory",
    },
    ...projects,
  ];
}

/** Scope options for DETACH: only the scopes the picked hook is attached to. */
function hookDetachScopeOptions(
  picked: Record<string, string>,
  { hooks }: RegistryView,
): PaletteOption[] {
  const hook = (hooks ?? []).find((h) => h.name === picked.hook);
  if (!hook) return [];
  const out: PaletteOption[] = [];
  if (hook.attached_global) {
    out.push({ id: "global", name: "Global — all sessions", icon: "globe" });
  }
  for (const p of hook.attached_projects) {
    out.push({ id: `project:${p}`, name: p, icon: "project" });
  }
  return out;
}

function hookScopeLabel(scope: string): string {
  return scope === "global" ? "globally" : `to ${scope.replace(/^project:/, "")}`;
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
    id: "attach-hook",
    label: "Attach hook…",
    icon: "bolt",
    args: [
      { name: "hook", title: "Pick a hook", kind: "list", options: hookOptions },
      {
        name: "scope",
        title: "Attach where",
        kind: "list",
        options: hookAttachScopeOptions,
      },
    ],
    run: async ({ hook, scope }, ctx) => {
      const commit = () =>
        ctx.runUndoable({
          do: () => hookScopeCmd("hook_attach", hook, scope),
          undo: () => hookScopeCmd("hook_detach", hook, scope),
          label: `Attached ${hook} ${hookScopeLabel(scope)}`,
          invalidate: HOOK_INVALIDATE,
        });
      if (scope === "global") {
        // A global attach fires in every session of that harness on this
        // machine — every directory, registered project or not. Gate it.
        ctx.confirm({
          title: `Attach ${hook} to all sessions?`,
          body: `This hook will fire in all sessions of that harness on this machine — every directory, registered project or not.`,
          confirmLabel: "Attach globally",
          onConfirm: commit,
        });
        return;
      }
      await commit();
    },
  },
  {
    id: "detach-hook",
    label: "Detach hook…",
    icon: "bolt",
    args: [
      { name: "hook", title: "Pick a hook", kind: "list", options: hookOptions },
      {
        name: "scope",
        title: "Detach from where",
        kind: "list",
        options: hookDetachScopeOptions,
      },
    ],
    run: async ({ hook, scope }, ctx) => {
      await ctx.runUndoable({
        do: () => hookScopeCmd("hook_detach", hook, scope),
        undo: () => hookScopeCmd("hook_attach", hook, scope),
        label: `Detached ${hook} ${hookScopeLabel(scope)}`,
        invalidate: HOOK_INVALIDATE,
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
