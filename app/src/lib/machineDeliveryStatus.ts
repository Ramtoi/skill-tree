import type { Machine, MachinePreview, Revision } from "@/lib/headlessMachines";
import type { BadgeChannel } from "@/components/StatusBadge";

export type DeliverySetting = "enabled" | "paused" | "off";

export interface MachineDeliveryStatus {
  setting: DeliverySetting;
  settingLabel: string;
  outcomeLabel: string;
  outcomeTitle: string;
  outcomeChannel: BadgeChannel;
  outcomeMessage: string;
  published: Revision | null;
  currentApplied: Revision | null;
  lastConfirmedApplied: Revision | null;
  resultObservedAt: string | null;
  confirmationObserved: boolean;
  inspectionIsCurrent: boolean;
  inspectionObservedAt: string | null;
  inspectionCandidate: Revision | null;
  inspectionApplied: Revision | null;
  inspectionBlockers: MachinePreview["blockers"];
}

function sameRevision(left: Revision | null | undefined, right: Revision | null | undefined): boolean {
  return !!left && !!right && left.generation === right.generation && left.revision === right.revision;
}

function revisionForPublication(
  revision: Revision | null | undefined,
  published: Revision | null,
): Revision | null {
  return sameRevision(revision, published) ? revision! : null;
}

function stateLabel(state: string): string {
  return state.replace(/_/g, " ").replace(/^./, value => value.toUpperCase());
}

function newerRevision(left: Revision | null, right: Revision | null): Revision | null {
  if (!left) return right;
  if (!right) return left;
  return left.generation >= right.generation ? left : right;
}

export function inspectionBlockerMessage(blocker: MachinePreview["blockers"][number]): string {
  const path = blocker.path ? ` at ${blocker.path}` : "";
  switch (blocker.code) {
    case "blocked_drift": return `Remote edits are preserved${path}. Review the receiver changes, then preview again.`;
    case "approval_required": return `Native receiver changes need review${path}. Preview the latest loadouts, then review the approval.`;
    case "feed_invalid": return "The receiver rejected the delivery feed. Check the feed URL and receiver setup, then preview again.";
    case "authentication_required": return "The receiver needs authentication. Repair the receiver connection, then refresh its status.";
    case "receiver_unreachable": return "The receiver could not be reached. Check its connection, then refresh its status.";
    default: return `${stateLabel(blocker.code)}${path}. Preview again after resolving this receiver check.`;
  }
}

function deliveryErrorMessage(code: string | undefined): string | null {
  if (code === "feed_invalid") return "The receiver rejected the delivery feed. Check the feed URL and receiver setup, then preview again.";
  if (code === "authentication_required") return "The receiver needs authentication. Repair the receiver connection, then refresh its status.";
  return null;
}

export function machineDeliveryStatus(
  machine: Machine,
  options: { actionError?: string | null; delivering?: boolean } = {},
): MachineDeliveryStatus {
  const draft = machine.draft;
  const observations = draft?.observations;
  const setting: DeliverySetting = machine.sync_enabled
    ? "enabled"
    : draft?.phase === "paused" || machine.phase === "paused" || !!observations?.start
      ? "paused"
      : "off";
  const settingLabel = setting === "enabled"
    ? "Automatic delivery enabled"
    : setting === "paused" ? "Automatic delivery paused" : "Automatic delivery off";

  const delivery = machine.delivery;
  const published = delivery?.published ?? null;
  const statusApplied = observations?.status?.applied ?? null;
  const persistedApplied = delivery?.applied ?? null;
  const statusCurrentApplied = published ? revisionForPublication(statusApplied, published) : null;
  const persistedCurrentApplied = revisionForPublication(persistedApplied, published);
  const currentApplied = statusCurrentApplied ?? persistedCurrentApplied;
  const lastConfirmedApplied = newerRevision(statusApplied, persistedApplied);
  const rawInspection = observations?.inspection;
  const inspectionIsCurrent = !!rawInspection && (
    "published" in rawInspection
      ? (rawInspection.published == null && published == null) || sameRevision(rawInspection.published, published)
      : !published || sameRevision(rawInspection.plan.candidate, published) || !rawInspection.plan.candidate
  );
  const inspection = inspectionIsCurrent ? rawInspection : null;
  const inspectionFailed = !!inspection && inspection.plan.ok !== true;
  const inspectionBlockers = inspection?.plan.blockers ?? [];
  const inspectionReady = !!inspection && inspection.plan.ok === true && inspectionBlockers.length === 0;
  const error = options.actionError || delivery?.error?.message;
  const blockers = observations?.preview?.blockers ?? [];

  let outcomeLabel = "No delivery yet";
  let outcomeTitle = "Delivery";
  let outcomeChannel: BadgeChannel = "neutral";
  let outcomeMessage = setting === "paused"
    ? "Automatic delivery is paused. Review the preview before resuming."
    : "No publication has been confirmed yet.";
  if (options.delivering) {
    outcomeLabel = "Delivering";
    outcomeTitle = "Delivery in progress";
    outcomeChannel = "neutral";
    outcomeMessage = "Waiting for the receiver to confirm this attempt.";
  } else if (options.actionError || (error && !inspectionBlockers.length && !inspectionReady && !inspectionFailed)) {
    const knownReceiverBlock = ["ownership_conflict", "blocked_drift", "unmanaged_existing"].includes(delivery?.error?.code ?? "");
    outcomeLabel = options.actionError ? "Action failed" : delivery?.error?.code === "receiver_unreachable" ? "Receiver unreachable" : knownReceiverBlock ? "Blocked" : "Needs attention";
    outcomeTitle = options.actionError ? "Last action failed" : delivery?.error?.code === "receiver_unreachable" ? "Delivery not confirmed" : knownReceiverBlock ? "Delivery blocked" : "Delivery needs attention";
    outcomeChannel = "error";
    outcomeMessage = options.actionError
      ? "Retry the action after resolving the error."
      : delivery?.error?.code === "receiver_unreachable"
        ? "The last delivery attempt could not reach the receiver. Refresh receiver status or retry delivery."
        : deliveryErrorMessage(delivery?.error?.code)
          ?? (knownReceiverBlock
            ? "The receiver blocked this publication. Review the preview before retrying."
            : "Review the saved delivery error before retrying.")
  } else if (inspectionBlockers.length) {
    outcomeLabel = "Blocked";
    outcomeTitle = "Delivery blocked";
    outcomeChannel = inspectionBlockers.some(blocker => blocker.code !== "approval_required") ? "error" : "warn";
    outcomeMessage = "The receiver responded, but delivery is blocked. Review the current blockers below.";
  } else if (inspectionFailed) {
    outcomeLabel = "Inspection failed";
    outcomeTitle = "Receiver inspection failed";
    outcomeChannel = "error";
    outcomeMessage = "The receiver could not produce a usable plan. Preview the latest loadouts to review the current error.";
  } else if (observations?.interval_update) {
    outcomeLabel = "Needs attention";
    outcomeTitle = "Delivery needs attention";
    outcomeChannel = "warn";
    outcomeMessage = observations.interval_update.message;
  } else if (inspectionReady && !currentApplied) {
    outcomeLabel = "Inspection ready";
    outcomeTitle = "Receiver inspection ready";
    outcomeChannel = "info";
    outcomeMessage = "No blockers found. Preview the latest loadouts before delivering.";
  } else if (blockers.length && !inspectionReady) {
    outcomeLabel = "Preview blocked";
    outcomeTitle = "Delivery preview blocked";
    outcomeChannel = "warn";
    outcomeMessage = "Resolve the preview blockers before delivering.";
  } else if (currentApplied && (delivery?.state === "applied" || delivery?.state === "unchanged" || !!observations?.status?.applied)) {
    outcomeLabel = delivery?.state === "unchanged" ? "Up to date" : "Confirmed";
    outcomeTitle = delivery?.state === "unchanged" ? "Delivery unchanged" : "Delivery confirmed";
    outcomeChannel = "ok";
    outcomeMessage = delivery?.state === "unchanged"
      ? "The receiver confirmed that the current publication is unchanged."
      : "The receiver confirmed the current publication.";
  } else if (delivery?.state === "published_waiting_for_receiver" || (published && !currentApplied)) {
    outcomeLabel = "Awaiting receiver";
    outcomeTitle = "Awaiting confirmation";
    outcomeChannel = "info";
    outcomeMessage = "Published, but this revision has no confirmed applied receipt. Refresh receiver status to check it.";
  } else if (delivery?.state && !["applied", "unchanged"].includes(delivery.state)) {
    outcomeLabel = stateLabel(delivery.state);
    outcomeTitle = `Delivery ${outcomeLabel.toLowerCase()}`;
    outcomeChannel = "neutral";
    outcomeMessage = `Last delivery result: ${stateLabel(delivery.state)}.`;
  }

  return {
    setting,
    settingLabel,
    outcomeLabel,
    outcomeTitle,
    outcomeChannel,
    outcomeMessage,
    published,
    currentApplied,
    lastConfirmedApplied,
    resultObservedAt: delivery?.observed_at ?? null,
    confirmationObserved: !!persistedCurrentApplied && (delivery?.state === "applied" || delivery?.state === "unchanged"),
    inspectionIsCurrent,
    inspectionObservedAt: inspection?.observed_at ?? null,
    inspectionCandidate: inspection?.plan.candidate ?? null,
    inspectionApplied: inspection?.plan.applied ?? null,
    inspectionBlockers,
  };
}
