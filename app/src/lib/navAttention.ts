import type { NavigateOptions } from "react-router-dom";

export interface AttentionAction {
  label: string;
  href: string;
  navState?: NavigateOptions;
}
export interface AttentionItem {
  id: string;
  label: string;
  detail?: string;
  action?: AttentionAction;
}

// Copy describes the recorded condition, its consequence, and a real product action.
const explanations = {
  "projects.failed": ["Project sync failed", "The last sync reported errors for these projects.", "Their agent folders may not match the selected skills and settings.", "Open a project to inspect its sync errors, then use Sync after addressing the cause."],
  "projects.affinitySkip": ["Skills cannot reach an agent", "These equipped skills do not match any effective installed harness on their project.", "Those skills are not available to an agent through this project’s loadout.", "Open the project to review the skill’s harness affinity and configure harnesses."],
  "projects.noAgent": ["Projects have no active agent", "These projects have no installed harness enabled through their own or global settings.", "Their selected skills cannot be delivered to an agent.", "Open the project and configure its harnesses."],
  "projects.missingRefs": ["Referenced skills are not equipped", "Equipped skills refer to other registered skills that are not equipped on these projects.", "An agent can follow a reference to instructions that are unavailable in its loadout.", "Open a project’s Loadout to review and equip the missing references."],
  "projects.stale": ["Projects need a sync", "The registry changed after these projects were last synced.", "Their agent folders may still contain the previous selection or settings.", "Open a project and choose Sync to write the current registry."],
  "projects.unattached": ["Projects have no local directory attached", "These projects have no local checkout on this machine — often after restoring a backup on a different machine.", "Sync makes no writes for them until a directory is attached. Their loadout, bundles, and settings stay saved and are not lost.", "Attach a directory to a project to make it eligible for sync again."],
  "projects.freshFindings": ["Usage suggestions to review", "The recent usage analysis recorded these observations.", "They can identify loadout or instruction changes worth reviewing; they are suggestions, not confirmed faults.", "Choose an observation to open its existing review flow. Changes remain your choice."],
  "context.descriptionOver200": ["Skill descriptions are too long", "These descriptions exceed the recommended 200-character limit.", "Long descriptions add discovery text for agents and make the skill harder to scan.", "Inspect the skill’s metadata. For a source-managed skill, use its source actions to find the original; its local copy can be read-only."],
  "context.conflicted": ["Skill invocation settings conflict", "Both invocation flags are set in these skills’ frontmatter.", "Claude cannot see the skill, and the skill is also hidden from your slash-command menu.", "Choose a triggering mode in the skill editor. For source-managed skills, change the original source or use a per-project override."],
  "context.sourceMissing": ["Skills were removed upstream", "These registered skills are no longer present in their source.", "Their local records remain, but updating the source cannot restore a skill it no longer contains.", "Inspect each skill or open Sources to review the removed skills and choose whether to forget them."],
  "context.bundleMissing": ["Bundles contain missing skills", "These bundles name skills that are no longer in the registry.", "Applying a bundle cannot equip its missing members.", "Open a bundle and use Remove missing skills, or restore the missing skills before applying it."],
  "context.snippetOutdated": ["Applied snippets need an update", "These snippets have applied copies that predate their current library text.", "Agent documents can still contain the older instructions.", "Open a snippet to review its applied locations and choose Update or Update everywhere."],
  "guardrails.doctor": ["Permission risks were found", "The permission doctor reported risks during the last sync.", "These rules or settings may allow more access than intended.", "Open Permissions, then choose Open doctor from the header menu to review the findings."],
  "guardrails.permissionsStreamFailed": ["Permission sync failed", "The last sync could not finish the permissions step.", "Agent permission files may not match the registry.", "Inspect the recorded errors and open Permissions to review the configuration before syncing again."],
  "guardrails.hooksStreamFailed": ["Hook sync failed", "The last sync could not finish the hooks step.", "Agent hook files may not match the configured hooks.", "Inspect the recorded errors and open Hooks to review the configuration before syncing again."],
  "guardrails.unsafeCombo": ["Codex commands have unrestricted access", "Codex combines never asking for approval with full filesystem access.", "Commands can run without approval or filesystem sandbox restrictions.", "Open Permissions to review the Codex approval policy and sandbox mode."],
  "guardrails.unmanaged": ["Permission rules are not managed here", "These harnesses have permission rules outside Skill Tree’s management.", "The registry does not control those rules until you review and adopt them.", "Open Permissions to review the existing rules and the adoption options."],
  "guardrails.hookSudo": ["Hook commands use sudo", "These hook commands include sudo.", "They can request elevated privileges when their hook event runs.", "Inspect the hook command and its attachments. Edit a user-defined command or detach the hook if it is not intended."],
  "agents.onNotInstalled": ["Enabled agents are not installed", "These harnesses are enabled globally but were not found on this machine.", "Skill Tree cannot deliver their configuration to a working installation.", "Open Harnesses to disable the unavailable harness, or install it and refresh harness detection."],
  "agents.invalidSubagent": ["Sub-agent definitions need attention", "These sub-agents have an invalid definition or a missing linked copy.", "An invalid definition may not load. A missing linked copy breaks the expected pair of files.", "Open the named agent to inspect its definition. For a missing linked copy, review Linked twin and its Unlink option."],
  "agents.usageScanFailed": ["Saved usage could not be loaded", "The cached usage result could not be read.", "Usage totals are unavailable here. This does not establish that a new scan ran or failed.", "Open Usage to inspect the error and choose Refresh."],
  "elsewhere.sourceUpdate": ["Source updates are available", "These enabled sources have updates available.", "Their registered skills may be behind the source version.", "Open a source card to review it and choose Update."],
  "elsewhere.sourceFailing": ["Source updates failed", "These enabled sources report an error.", "Their skills may not contain the latest source content.", "Open a source card to inspect its error and update settings before retrying."],
  "elsewhere.remotesAlarmed": ["Remote sync needs attention", "The last sync reported remote targets that need attention.", "A remote can be behind or have conflicting edits. The summary does not identify which targets failed.", "Open Remotes to inspect target status and choose the appropriate sync or conflict-resolution flow."],
  "elsewhere.backupHealth": ["Backup needs attention", "The backup status reports a condition that prevents publication.", "The remote backup may not contain the latest local snapshot.", "Open Backup to inspect the reason and its available review or retry action."],
  "elsewhere.cloudUnexportable": ["Cloud selections include excluded skills", "These selected entries cannot be included in their cloud export.", "MCP servers and missing skills cannot appear in the exported skill archive.", "Open the affected cloud target to review its selection and excluded entries."],
} as const;

export type AttentionKind = keyof typeof explanations;
export interface AttentionLine {
  key: AttentionKind;
  tone: "warn" | "error";
  text: string;
  explanation: {
    title: string;
    happened: string;
    impact: string;
    nextStep: string;
    affected: AttentionItem[];
    action?: AttentionAction;
  };
}

export type ActionableAttentionItem = AttentionItem & { action: AttentionAction };
export function attentionLine(key: AttentionKind, tone: AttentionLine["tone"], text: string, affected: ActionableAttentionItem[]): AttentionLine;
export function attentionLine(key: AttentionKind, tone: AttentionLine["tone"], text: string, affected: AttentionItem[], action: AttentionAction): AttentionLine;
export function attentionLine(key: AttentionKind, tone: AttentionLine["tone"], text: string, affected: AttentionItem[], action?: AttentionAction): AttentionLine {
  const [title, happened, impact, nextStep] = explanations[key];
  return { key, tone, text, explanation: { title, happened, impact, nextStep, affected, action } };
}

/** Reports from older versions do not all carry the same error shape. */
export function reportErrorDetails(errors: unknown[] | undefined): string | undefined {
  const messages = (errors ?? []).flatMap((error) => {
    if (typeof error === "string") return [error];
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return [error.message];
    return [];
  });
  return messages.length ? messages.join("\n") : undefined;
}
