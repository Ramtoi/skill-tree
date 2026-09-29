// Map raw ssh/ssh-keyscan stderr (or a connector `detail` string) to a short,
// plain-language hint + a suggested recovery action. The raw detail is always
// kept as secondary text; the hint is what a non-expert reads first.
//
// Pure + dependency-free so it unit-tests trivially and is safe to call from any
// render path (chip title, banner, wizard error panel).

export type SshRecovery =
	| "none"
	| "wake-box"
	| "re-pin"
	| "install-key"
	| "install-hermes";

export interface SshHint {
	/** Plain-language, one-line explanation. Empty string when nothing matched. */
	hint: string;
	/** Suggested recovery affordance the UI can surface. */
	recovery: SshRecovery;
}

const NO_HINT: SshHint = { hint: "", recovery: "none" };

/** Map a structured `detail_kind` (from a probe/health payload) to a hint +
 *  recovery. Preferred over `sshErrorHint` when the backend supplies a kind: it
 *  classifies from the machine tag instead of string-matching a raw `detail`.
 *  An unknown/empty kind returns NO_HINT so the caller can fall back to
 *  substring matching on the raw string. */
export function sshHintForKind(
	kind: string | null | undefined,
): SshHint {
	switch (kind) {
		case "host_key_mismatch":
			return {
				hint: "The box's host key changed. If this rotation is legitimate, re-pin it; if not, it could be a machine-in-the-middle.",
				recovery: "re-pin",
			};
		case "auth_failed":
			return {
				hint: "The box refused our key. Install your SSH key on the box, or make sure the box already trusts it.",
				recovery: "install-key",
			};
		case "unreachable":
			return {
				hint: "The box didn't answer — it may be asleep, offline, or unreachable from here. Wake it and retry.",
				recovery: "wake-box",
			};
		case "home_missing":
			return {
				hint: "Connected, but the connector isn't set up on this box yet. Install it there, then retry.",
				recovery: "install-hermes",
			};
		default:
			return NO_HINT;
	}
}

/** Classify a raw ssh error / connector detail string into a friendly hint.
 *  Matching is case-insensitive and order-sensitive (most specific first). */
export function sshErrorHint(detail: string | null | undefined): SshHint {
	if (!detail) return NO_HINT;
	const d = detail.toLowerCase();

	// Host-key changed → re-pin (this is BEFORE auth, since a mismatch string can
	// also mention "key").
	if (
		d.includes("host key verification failed") ||
		d.includes("host key mismatch") ||
		d.includes("host-key mismatch") ||
		d.includes("does not match the pinned") ||
		d.includes("remote host identification has changed")
	) {
		return {
			hint: "The box's host key changed. If this rotation is legitimate, re-pin it; if not, it could be a machine-in-the-middle.",
			recovery: "re-pin",
		};
	}

	// Key not installed / rejected → install our key on the box.
	if (
		d.includes("permission denied") ||
		d.includes("publickey") ||
		d.includes("authentication failed") ||
		d.includes("too many authentication failures")
	) {
		return {
			hint: "The box refused our key. Install your SSH key on the box, or make sure the box already trusts it.",
			recovery: "install-key",
		};
	}

	// Reachability — box asleep / offline / unroutable.
	if (
		d.includes("operation timed out") ||
		d.includes("connection timed out") ||
		d.includes("timed out") ||
		d.includes("no route to host") ||
		d.includes("connection refused") ||
		d.includes("could not resolve") ||
		d.includes("name or service not known") ||
		d.includes("network is unreachable") ||
		d.includes("host is down")
	) {
		return {
			hint: "The box didn't answer — it may be asleep, offline, or unreachable from here. Wake it and retry.",
			recovery: "wake-box",
		};
	}

	// Hermes not installed (our own home_missing detail).
	if (
		d.includes("~/.hermes not found") ||
		d.includes("is hermes installed") ||
		d.includes("not found — is hermes")
	) {
		return {
			hint: "Connected, but Hermes isn't set up on this box (~/.hermes is missing). Install Hermes there, then retry.",
			recovery: "install-hermes",
		};
	}

	return NO_HINT;
}
