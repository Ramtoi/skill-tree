import type { Machine } from "@/lib/headlessMachines";
import { mockRemoteDefaults } from "./remoteDefaults";
import { sceneFlag } from "./scenes";

const KEY = "st:mock:machines";
export function mockHeadlessMachines(args: string[]) {
  const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Machine>;
  const verb = args[2];
  const id = args[3];
  const option = (key: string) => args[args.indexOf(key) + 1];
  if (sceneFlag("machineBlocked") && !saved["build-box"]) {
    saved["build-box"] = {
      id: "build-box", connector: "headless-loadouts", phase: "ready", sync_enabled: true,
      draft: { revision: 4, input: { ssh_host: "build-box", host_key_sha256: "SHA256:exampleFingerprintForPreviewOnly01234567890",
        feed_url: "git@example.org:team/private-loadouts.git", private_feed_confirmed: true, poll_interval_seconds: 300 },
        observations: { connect: "confirmed", install: { command: "/home/example/.local/share/skill-tree/receiver/bin/hub" },
          configure: {}, start: {}, preview: { ok: true, state: "ready", plan_digest: "mock-reviewed-plan", approval_digest: null,
            blockers: [], changes: [{ action: "write", path: "/home/example/projects/app/.agents/skills/review/SKILL.md" }] } } },
      bindings: { application: { source_project: "my-project", mode: "repository", harnesses: ["codex", "claude-code"] } },
      delivery: { state: "ownership_conflict", published: { revision: "a".repeat(40), generation: 1 }, applied: null,
        observed_at: "2026-09-28T14:01:01Z", error: { code: "ownership_conflict",
          message: "The receiver blocked delivery. Preview the loadout to review its blockers." } },
    };
    localStorage.setItem(KEY, JSON.stringify(saved));
  }
  if (sceneFlag("machineConflict") && !saved["build-box"]) {
    saved["build-box"] = {
      id: "build-box", connector: "headless-loadouts", phase: "installed", sync_enabled: false,
      draft: { revision: 3, input: { ssh_host: "build-box", host_key_sha256: "SHA256:exampleFingerprintForPreviewOnly01234567890",
        feed_url: "git@example.org:team/private-loadouts.git", private_feed_confirmed: true, poll_interval_seconds: 60 },
        observations: { connect: "confirmed", install: { command: "/home/example/.local/share/skill-tree/receiver/bin/hub" },
          channel_conflict: { feed_id: "6f4c606b201e4d5ab2518bd32fdf136d", publisher_key_id: "SHA256:0f2b9c1d7e4a6b83",
            controller_key_id: "SHA256:9a71e4c2b0d5f638", applied: { generation: 3, applied_at: "2026-09-17T12:13:14Z" } } } },
      bindings: {},
      delivery: { state: "setup_required", published: null, applied: null, observed_at: null,
        error: { message: "Could not publish this machine's loadout. Review its setup.", code: "setup_required" } },
    };
    localStorage.setItem(KEY, JSON.stringify(saved));
  }
  if (verb === "list") return { ok: true, result: Object.values(saved), error: null };
  if (verb === "draft") {
    const input = JSON.parse(option("--settings-json"));
    saved[id] ??= { id, connector: "headless-loadouts", phase: "draft", sync_enabled: false,
      draft: { revision: 0, input: { poll_interval_seconds: mockRemoteDefaults(["remote", "defaults", "show"]).defaults?.poll_interval_seconds || 60 }, observations: {} }, bindings: {}, delivery: null };
    Object.assign(saved[id].draft!.input, input);
  }
  const machine = saved[id];
  if (!machine?.draft) return { ok: false, result: null, error: { message: "Machine draft not found." } };
  const observations = machine.draft.observations;
  if (verb !== "show" && verb !== "status") delete observations.inspection;
  if (verb === "connect") { observations.connect = "confirmed"; machine.phase = "connected"; }
  if (verb === "install") { observations.install = { command: "/home/example/.local/share/skill-tree/receiver/bin/hub" }; machine.phase = "installed"; }
  if (verb === "interval") {
    machine.draft.input.poll_interval_seconds = Number(option("--poll-interval-seconds"));
    delete observations.interval_update;
  }
  if (verb === "configure") {
    if (observations.channel_conflict && !args.includes("--replace-channel")) {
      return { ok: false, result: null, error: { code: "channel_rotation_required",
        message: "The receiver already delivers loadouts for another Skill Tree installation. Reconnect it to replace that channel with this Mac's identity." } };
    }
    if (args.includes("--replace-channel")) { delete observations.channel_conflict; delete observations.needs_reconnect_demo; observations.configure = { replace_feed: true }; }
    else observations.configure = {};
    machine.phase = "configured";
  }
  if (verb === "bind" || verb === "reconfirm") {
    machine.bindings![option("--binding")] = { source_project: option("--project"),
      global_native: args.filter((_, i) => args[i - 1] === "--global-native"),
      global_agents: args.filter((_, i) => args[i - 1] === "--global-agent"),
      mode: args.includes("--manual") ? "manual" : "repository", harnesses: args.filter((_, i) => args[i - 1] === "--harness") };
    machine.phase = "bound"; delete observations.preview;
  }
  if (verb === "unbind") { delete machine.bindings![option("--binding")]; delete observations.preview; }
  if (verb === "preview" && observations.needs_reconnect_demo) {
    const message = "The feed branch head was published by another Skill Tree installation. Reconnect the receiver to publish from this Mac.";
    machine.delivery = { ...(machine.delivery || {}), state: "feed_reconnect_required", error: { code: "feed_reconnect_required", message } } as Machine["delivery"];
    localStorage.setItem(KEY, JSON.stringify(saved));
    return { ok: false, result: null, error: { code: "feed_reconnect_required", message } };
  }
  if (verb === "preview" || verb === "approve") {
    if (machine.delivery) machine.delivery.error = null;
    observations.preview = { ok: true, state: "ready", plan_digest: "mock-reviewed-plan", approval_digest: null,
      blockers: [], changes: [{ action: "write", path: "/home/example/projects/app/.agents/skills/review/SKILL.md" }] };
    machine.phase = "previewed";
  }
  if (verb === "preview" && Object.values(machine.bindings || {}).some(binding => binding.global_native?.length)) {
    observations.preview = { ok: false, state: "approval_required", plan_digest: "mock-native-plan", approval_digest: "mock-native-approval",
      blockers: [{ code: "approval_required" }], changes: [{ action: "write", path: "/home/example/.claude/settings.json" }],
      native_review: { entries: [{ path: "/home/example/.claude/settings.json", selector: ["permissions", "deny"], value: "Bash(rm:*)" }], files: [], removals: [], retained_bindings: [] } };
  }
  if (verb === "start") {
    machine.phase = "ready"; machine.sync_enabled = true; observations.start = {};
    machine.delivery = { state: "applied", published: { revision: "a".repeat(40), generation: 1 },
      applied: { revision: "a".repeat(40), generation: 1 }, observed_at: "2026-09-16T12:00:00Z" };
  }
  if (verb === "pause") { machine.phase = "paused"; machine.sync_enabled = false; }
  if (verb === "status") {
    const blocked = machine.delivery?.error?.code === "ownership_conflict";
    const candidate = machine.delivery?.published ?? null;
    observations.status = { applied: machine.delivery?.applied, paused: machine.phase === "paused" };
    observations.inspection = {
      observed_at: "2026-09-28T14:05:00Z",
      published: candidate,
      plan: { ok: !blocked, state: blocked ? "blocked" : "ready", plan_digest: "mock-inspection-plan",
        approval_digest: blocked ? "mock-inspection-approval" : null, candidate, applied: machine.delivery?.applied ?? null,
        blockers: blocked ? [{ code: "blocked_drift", path: "/home/example/projects/app/.codex/skills/review/SKILL.md" },
          { code: "approval_required", path: "/home/example/.claude/settings.json" }] : [],
        changes: blocked ? [{ action: "preserve", path: "/home/example/projects/app/.codex/skills/review/SKILL.md" }] : [] },
    };
  }
  if (verb !== "show") machine.draft.revision += 1;
  localStorage.setItem(KEY, JSON.stringify(saved));
  return { ok: true, result: verb === "discover" ? { ...machine, result: { candidates: [{ path: "/home/example/projects/app", matches: [{ source_project: "example-app", source_remote: "origin", destination_remote: "origin", checkout_path: "/home/example/projects/app" }] }], partial: false } } : machine, error: null };
}
