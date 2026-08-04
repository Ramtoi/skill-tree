// Turn a remote health/diff payload into the display grammar the chips + banner
// share, so RemotesScreen and RemoteDetail classify identically.
//
// Colour contract (COMPONENTS.md §Accents): status red is reserved for REAL
// errors (auth failure, host-key mismatch). "Not set up" (Hermes missing) and
// "unreachable" are NEUTRAL absences — never red, NEVER amber (amber is
// provenance/risk only).

import { sshErrorHint, type SshRecovery } from "./sshErrorHint";
import type { RemoteDetailKind } from "@/types";

export interface HealthLike {
	ok?: boolean;
	reachable?: boolean;
	authenticated?: boolean;
	ready?: boolean;
	detail_kind?: RemoteDetailKind;
	detail?: string;
}

export type HealthTone = "ok" | "error" | "neutral";

export interface RemoteHealthView {
	tone: HealthTone;
	label: string;
	detail: string;
	/** Plain-language hint (from sshErrorHint or a kind-specific default). */
	hint: string;
	/** Suggested recovery affordance. */
	recovery: SshRecovery;
	/** True when the state warrants a prominent banner, not just a chip. */
	alert: boolean;
}

export function classifyRemoteHealth(
	h: HealthLike | undefined | null,
): RemoteHealthView {
	if (!h)
		return {
			tone: "neutral",
			label: "checking…",
			detail: "",
			hint: "",
			recovery: "none",
			alert: false,
		};
	const detail = h.detail ?? "";
	const kind = h.detail_kind ?? "";
	const { hint, recovery } = sshErrorHint(detail);

	if (h.ok === true)
		return { tone: "ok", label: "ready", detail, hint: "", recovery: "none", alert: false };

	// home_missing → NEUTRAL "not set up" (Hermes not installed). Informative,
	// never a red error. The box IS authenticated, so DON'T offer "install key"
	// (that would be a dead end): recovery is "none" — the banner shows the hint
	// plus the existing Re-check affordance only.
	if (kind === "home_missing")
		return {
			tone: "neutral",
			label: "not set up",
			detail,
			hint:
				hint ||
				"Connected, but Hermes isn't installed on this box (~/.hermes is missing).",
			recovery: "none",
			alert: true,
		};

	// host_key_mismatch → RED (possible MITM).
	if (kind === "host_key_mismatch")
		return {
			tone: "error",
			label: "host-key mismatch",
			detail,
			hint: hint || "The box's host key does not match the pin.",
			recovery: recovery === "none" ? "re-pin" : recovery,
			alert: true,
		};

	// auth_failed → RED (box rejects our key).
	if (kind === "auth_failed" || (h.authenticated === false && h.reachable !== false))
		return {
			tone: "error",
			label: "auth failed",
			detail,
			hint: hint || "The box refused our key — install it or grant access.",
			recovery: recovery === "none" ? "install-key" : recovery,
			alert: true,
		};

	// unreachable → NEUTRAL absence.
	if (kind === "unreachable" || h.reachable === false)
		return {
			tone: "neutral",
			label: "unreachable",
			detail,
			hint: hint || "The box didn't answer — it may be asleep or offline.",
			recovery: recovery === "none" ? "wake-box" : recovery,
			alert: true,
		};

	return { tone: "neutral", label: "not ready", detail, hint, recovery, alert: false };
}
