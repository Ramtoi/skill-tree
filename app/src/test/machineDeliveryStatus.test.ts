import { expect, it } from "vitest";
import type { Machine } from "@/lib/headlessMachines";
import { machineDeliveryStatus } from "@/lib/machineDeliveryStatus";

const current = { revision: "current", generation: 2 };
const previous = { revision: "previous", generation: 1 };
function machine(): Machine {
  return {
    id: "box", connector: "headless-loadouts", phase: "ready", sync_enabled: true,
    draft: { revision: 1, input: { poll_interval_seconds: 300 }, observations: {} },
    delivery: { state: "published_waiting_for_receiver", published: current, applied: previous,
      observed_at: "2026-09-28T14:00:00Z" },
  };
}

it("keeps a previous success separate from an unconfirmed publication", () => {
  const box = machine();
  box.delivery!.state = "applied";
  const status = machineDeliveryStatus(box);
  expect(status.outcomeTitle).toBe("Awaiting confirmation");
  expect(status.lastConfirmedApplied).toEqual(previous);
  expect(status.confirmationObserved).toBe(false);
});

it.each([
  { revision: "another-feed", generation: 2 },
  { revision: "current", generation: 1 },
])("does not confirm from a status receipt with different identity: %j", applied => {
  const box = machine();
  box.draft!.observations.status = { applied };
  expect(machineDeliveryStatus(box).outcomeTitle).toBe("Awaiting confirmation");
});

it("confirms a matching status receipt without giving it the previous attempt's timestamp", () => {
  const box = machine();
  box.draft!.observations.status = { applied: current };
  const status = machineDeliveryStatus(box);
  expect(status.outcomeTitle).toBe("Delivery confirmed");
  expect(status.lastConfirmedApplied).toEqual(current);
  expect(status.confirmationObserved).toBe(false);
});

it("does not let an undated saved status erase a later receiver error", () => {
  const box = machine();
  box.draft!.observations.status = { applied: current };
  box.delivery!.error = { code: "receiver_unreachable", retryable: true, message: "Receiver confirmation is pending." };
  expect(machineDeliveryStatus(box).outcomeChannel).not.toBe("ok");
});

it("preserves confirmed history when a new publication fails before it reaches the receiver", () => {
  const box = machine();
  box.delivery = { state: "unsupported_source", published: previous, applied: previous,
    error: { code: "unsupported_source", message: "A selected asset cannot be published." } };
  box.draft!.observations.status = { applied: previous };
  const status = machineDeliveryStatus(box);
  expect(status.outcomeTitle).toBe("Delivery needs attention");
  expect(status.lastConfirmedApplied).toEqual(previous);
});

it("does not hide a retryable publication failure behind an older confirmed publication", () => {
  const box = machine();
  box.delivery = { state: "feed_unavailable", published: previous, applied: previous,
    error: { code: "feed_unavailable", retryable: true, message: "Could not publish to the feed." } };
  box.draft!.observations.status = { applied: previous };
  expect(machineDeliveryStatus(box).outcomeTitle).toBe("Delivery needs attention");
});

it("keeps a persisted failure historical when a fresh inspection is clear", () => {
  const box = machine();
  box.delivery!.error = { code: "receiver_unreachable", retryable: true, message: "The previous attempt could not reach the receiver." };
  box.draft!.observations.inspection = {
    observed_at: "2026-09-28T14:05:00Z",
    plan: { ok: true, state: "ready", plan_digest: "inspection", approval_digest: null,
      candidate: current, applied: previous, blockers: [], changes: [] },
  };
  const status = machineDeliveryStatus(box);
  expect(status.outcomeTitle).toBe("Receiver inspection ready");
  expect(status.inspectionObservedAt).toBe("2026-09-28T14:05:00Z");
  expect(status.outcomeChannel).toBe("info");
});

it("surfaces a candidate-less feed failure with its inspection time", () => {
  const box = machine();
  const inspection = {
    observed_at: "2026-09-28T14:06:00Z", published: current,
    plan: { ok: false, state: "blocked", plan_digest: null, approval_digest: null,
      candidate: null, applied: null, blockers: [{ code: "feed_invalid" }], changes: [] },
  };
  box.draft!.observations.inspection = inspection;
  const status = machineDeliveryStatus(box);
  expect(status.inspectionIsCurrent).toBe(true);
  expect(status.outcomeTitle).toBe("Delivery blocked");
  expect(status.inspectionObservedAt).toBe("2026-09-28T14:06:00Z");
  expect(status.inspectionCandidate).toBeNull();
});

it("does not call an ok-false empty inspection ready", () => {
  const box = machine();
  box.draft!.observations.inspection = {
    observed_at: "2026-09-28T14:06:00Z", published: current,
    plan: { ok: false, state: "blocked", plan_digest: null, approval_digest: null,
      candidate: current, applied: null, blockers: [], changes: [] },
  };
  expect(machineDeliveryStatus(box).outcomeTitle).toBe("Receiver inspection failed");
});

it("invalidates a candidate-less failure after a later publication", () => {
  const box = machine();
  box.draft!.observations.inspection = {
    observed_at: "2026-09-28T14:06:00Z", published: current,
    plan: { ok: false, state: "blocked", plan_digest: null, approval_digest: null,
      candidate: null, applied: null, blockers: [{ code: "feed_invalid" }], changes: [] },
  };
  box.delivery!.published = { revision: "later", generation: 3 };
  const status = machineDeliveryStatus(box);
  expect(status.inspectionIsCurrent).toBe(false);
  expect(status.outcomeTitle).toBe("Awaiting confirmation");
});

it("distinguishes an in-flight retry from its previous blocked result", () => {
  const box = machine();
  box.delivery!.error = { code: "ownership_conflict", message: "The receiver blocked delivery." };
  expect(machineDeliveryStatus(box, { delivering: true }).outcomeTitle).toBe("Delivery in progress");
});

it("keeps pause separate from a confirmed delivery", () => {
  const box = machine();
  box.sync_enabled = false;
  box.phase = "paused";
  box.delivery = { state: "applied", published: current, applied: current };
  const status = machineDeliveryStatus(box);
  expect(status.settingLabel).toBe("Automatic delivery paused");
  expect(status.outcomeTitle).toBe("Delivery confirmed");
});

it("requires a published revision before claiming the current publication was delivered", () => {
  const box = machine();
  box.delivery = { state: "applied", applied: previous };
  expect(machineDeliveryStatus(box).outcomeChannel).not.toBe("ok");
});

it("shows action failure over old success and recovers after a successful retry", () => {
  const box = machine();
  box.delivery = { state: "applied", published: current, applied: current };
  expect(machineDeliveryStatus(box, { actionError: "Delivery failed." }).outcomeChannel).toBe("error");
  expect(machineDeliveryStatus(box).outcomeTitle).toBe("Delivery confirmed");
});
