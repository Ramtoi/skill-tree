import { invoke } from "@/lib/ipc";
import { runHubCmd, type HubResult } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { REGISTRY_WRITE_KEYS } from "@/lib/invalidate";
import { announceMissingRefs } from "@/lib/missingRefs";
import { buildRefsGuardrailDeps, type ToastPush } from "@/hooks/useEquip";
import { equipWithGate, equipErrorToast } from "@/hooks/useCompanionGate";
import { useAppStore } from "@/store";
import type { Registry } from "@/types";
import type { UndoableAction } from "@/hooks/useUndoableAction";
import type { HookRow } from "@/hooks/useHooks";
import { buildSkillProjectTargets } from "@/hooks/useEquipTargets";

/** A `ToastPush` with no hook context — `paletteVerbs`' verbs run outside a
 *  component, so they push through the store's `pushToast` action directly
 *  (the same default-kind fallback `useToast().push` applies) rather than
 *  taking a `useToast()` handle. */
const pushToastDirect: ToastPush = (t) =>
  useAppStore.getState().pushToast({
    kind: t.kind ?? "info",
    title: t.title,
    body: t.body,
    duration: t.duration,
    action: t.action,
  });

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

const EQUIP_INVALIDATE = REGISTRY_WRITE_KEYS;
const HOOK_INVALIDATE = [qk.hooks.all(), ...REGISTRY_WRITE_KEYS];

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
    icon: "hook",
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
      // Through the companion gate (I1/A4), not a raw `enable` — the palette
      // verb runs outside a component (same reason `pushToastDirect` bypasses
      // `useToast()`), so it calls the module-level `equipWithGate` directly
      // rather than the `useCompanionGate()` hook.
      try {
        await ctx.runUndoable({
          do: () => equipWithGate(skill, project),
          undo: () => runHubCmd(["disable", skill, "--project", project]).then(() => undefined),
          label: `Equipped ${skill} on ${project}`,
          invalidate: EQUIP_INVALIDATE,
        });
      } catch (err) {
        // The palette fires `run` with `void` (CommandPalette) — without this
        // a failed equip (or a landed equip whose companions failed) is an
        // unhandled rejection and zero feedback.
        const failure = equipErrorToast(err);
        pushToastDirect({ kind: "error", title: failure.title, body: failure.body });
        return;
      }
      await announceMissingRefs([skill], project, buildRefsGuardrailDeps(pushToastDirect, project));
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
        do: () => runHubCmd(["bundle", "apply", bundle, "--project", project]),
        undo: () =>
          runHubCmd(["bundle", "remove", bundle, "--project", project]).then(() => undefined),
        label: `Applied ${bundle} to ${project}`,
        invalidate: EQUIP_INVALIDATE,
      });
    },
  },
  {
    id: "attach-hook",
    label: "Attach hook…",
    icon: "hook",
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
    icon: "hook",
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
      ctx.navigate(`/snippet/new?name=${encodeURIComponent(name)}`);
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
          { id: "loadout", name: "Loadout", icon: "loadout" },
          { id: "permissions", name: "Permissions", icon: "permissions" },
          { id: "subagents", name: "Sub-Agents", icon: "agent" },
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
