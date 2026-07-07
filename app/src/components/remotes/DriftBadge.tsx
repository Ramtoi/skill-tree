import { StatusBadge, type BadgeChannel } from "@/components/StatusBadge";
import type { DriftStatus } from "@/types";

/** Map each drift status to a tone + human label. Tones map to the status
 *  palette (green=ok, blue=info/actionable-local, red=conflict) — never amber
 *  (reserved for direct-equip provenance, §5.2) and never the brand violet.
 *  Transitional drift (remote-drifted / orphaned / missing) is neutral + motion,
 *  the FreshnessBadge grammar: quiet, not a stolen hue. */
const DRIFT_META: Record<
	string,
	{ tone: BadgeChannel; label: string; hint: string; motion?: "pulse" }
> = {
	"in-sync": { tone: "ok", label: "in sync", hint: "Remote matches the hub." },
	"local-ahead": {
		tone: "info",
		label: "local-ahead",
		hint: "Local changed — next sync fast-forwards the remote.",
	},
	"remote-drifted": {
		tone: "neutral",
		label: "remote-drifted",
		hint: "The agent edited this on the box. Pull to adopt, or keep local.",
		motion: "pulse",
	},
	conflict: {
		tone: "error",
		label: "conflict",
		hint: "Both sides changed. Resolve explicitly — never auto-clobbered.",
	},
	orphaned: {
		tone: "neutral",
		label: "orphaned",
		hint: "Removed locally, still on the box (sidecar-scoped).",
		motion: "pulse",
	},
	missing: {
		tone: "neutral",
		label: "missing",
		hint: "Expected on the box, gone — the agent deleted it.",
		motion: "pulse",
	},
};

export function driftMeta(status: DriftStatus) {
	if (!status)
		return { tone: "neutral" as BadgeChannel, label: "—", hint: "" };
	return (
		DRIFT_META[status] ?? {
			tone: "neutral" as BadgeChannel,
			label: status,
			hint: "",
		}
	);
}

/** Remote-drift pill — a thin preset of `StatusBadge` (D10). Transitional drift
 *  carries neutral fill + motion (never amber); settled endpoints keep their
 *  status channel (ok / info / error). */
export function DriftBadge({ status }: { status: DriftStatus }) {
	const m = driftMeta(status);
	return (
		<StatusBadge
			channel={m.tone}
			shape="pill"
			motion={m.motion ?? "none"}
			title={m.hint}
		>
			{m.label}
		</StatusBadge>
	);
}

/** Human phrases for the raw plan verbs the connector emits. The raw verb is
 *  kept verbatim as the element's `title` (see RemoteDetail) for power users. */
const ACTION_PHRASES: Record<string, string> = {
	CREATE: "will create on the box",
	FAST_FORWARD: "will fast-forward",
	REMOVE: "will remove from the box",
	UPDATE: "will update",
	noop: "up to date",
	SKIP_remote_drifted: "skipped — remote changed",
	SKIP_conflict: "skipped — conflict, resolve first",
	SKIP_orphaned: "skipped — orphaned on the box",
	SKIP_missing: "skipped — missing on the box",
};

/** Map a raw plan verb to a human phrase (falls back to a lowercased,
 *  underscores-to-spaces form of the verb itself). */
export function humanizeAction(action: string | null | undefined): string {
	if (!action) return "";
	return (
		ACTION_PHRASES[action] ??
		action.replace(/^SKIP_/, "skipped — ").replace(/_/g, " ").toLowerCase()
	);
}

/** True when a status warrants an explicit resolve affordance. */
export function needsResolve(status: DriftStatus): boolean {
	return (
		status === "remote-drifted" ||
		status === "conflict" ||
		status === "orphaned" ||
		status === "missing"
	);
}

export type ResolveOp = "push" | "pull" | "keep-local" | "keep-remote";

/** Single source of truth for the per-action pending key. The producer (the
 *  `runHub` call that fires a resolve) and the matcher (the button deciding
 *  whether to spin) MUST build the key the same way — so both go through here. */
export function resolveActionKey(
	kind: string,
	name: string,
	op: ResolveOp,
): string {
	return `resolve:${kind}:${name}:${op}`;
}
