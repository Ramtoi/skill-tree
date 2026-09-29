import type { Registry } from "@/types";
import type { InvocationMode, InvocationOutcome, InvocationStatus } from "@/lib/invocation";
import { sceneValue } from "./scenes";

/** Preview fixtures for the native invocation query. No runtime evidence. */
export function invocationMock(registry: Registry, name: string, project?: string): InvocationStatus {
  const skill = registry.skills[name];
  const scene = sceneValue("invocationNative");
  const library = skill?.invocation ?? "auto";
  const override = skill?.scope === "global" ? undefined : registry.projects[project ?? ""]?.invocation_overrides?.[name];
  const effective = override ?? library;
  const available = scene === "all" ? ["claude-code", "codex", "pi", "opencode"]
    : scene?.startsWith("opencode") ? ["opencode"]
    : scene === "none" ? [] : scene ? ["codex"] : ["claude-code", "codex", "opencode"];
  const configured = project && skill?.scope !== "global"
    ? [...(registry.harnesses_global ?? []), ...(registry.projects[project]?.harnesses ?? [])]
    : available;
  const targets = available.filter((id) => configured.includes(id) && (!skill?.harnesses?.length || skill.harnesses.includes(id)));
  const rows = (mode: string, applied: boolean): InvocationOutcome[] => targets.map((harness) => {
    const opencode = harness === "opencode";
    const unknown = opencode && scene !== "opencode-shared" && scene !== "opencode-command";
    const command = opencode && scene === "opencode-command" && mode === "user-only";
    const unsupported = mode === "model-only" && harness !== "claude-code" || opencode && mode === "user-only" && !command;
    return {
      skill: name, harness, project, requested_mode: mode,
      mode_origin: override ? "project" : "library",
      capability_profile: opencode ? unknown ? "unknown" : "opencode-v1.18.31" : `${harness}-native`,
      support: unknown || mode === "conflicted" ? "unknown" : unsupported ? "unsupported" : mode === "auto" ? "native" : "enforced",
      implicit_behavior: mode === "user-only" && (!opencode || command) ? "disabled" : "enabled",
      explicit_behavior: mode === "model-only" && harness === "claude-code" ? "hidden" : "available",
      mechanism: command ? "opencode command-only delivery" : harness === "codex" ? "agents/openai.yaml policy.allow_implicit_invocation" : "SKILL.md",
      limitations: unsupported ? ["The requested restriction is unsupported here."] : [],
      delivery: applied ? scene === "yaml-failure" ? "failed" : "applied" : "pending",
      reason_code: scene === "yaml-failure" ? "invalid-yaml" : unknown ? "unknown-build" : undefined,
      reason: scene === "yaml-failure" ? "Codex policy contains invalid YAML. Retry sync after repairing the source." : undefined,
      input_fingerprint: "preview-fixture", observed_at: new Date().toISOString(),
    };
  });
  return {
    ok: Boolean(skill), skill: name, project, library, override, effective, targets,
    outcomes: rows(effective, true),
    previews: Object.fromEntries((["auto", "user-only", "model-only"] as InvocationMode[]).map((mode) => [mode, rows(mode, false)])) as InvocationStatus["previews"],
    overridden_projects: Object.entries(registry.projects).filter(([, p]) => p.invocation_overrides?.[name]).map(([p]) => p),
  };
}
