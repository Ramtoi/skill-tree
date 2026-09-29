import { hubCmd, hubStreams } from "@/lib/hubCmd";
import {
	cliLines,
	errorDetail,
	errorHeadline,
	type CliStreams,
} from "@/lib/cliOutput";
import { parseCliJson } from "@/lib/skillPack";

/**
 * Shared plumbing for `hub … --json` verbs that WRITE the registry and then
 * auto-sync. One implementation, used by every screen that runs one.
 *
 * This module owns the PAYLOAD contract (payload-first `--json` parsing, which
 * outcomes count as a landed write, warning surfacing). It does NOT own error
 * text: when a payload carries no error of its own, the message comes from
 * `lib/cliOutput`, the same extractor the sync failure card uses — so a bundle
 * write and a sync failure can never disagree about what "the error" is.
 */

/**
 * Parse a `hub … --json` reply.
 *
 * Every `--json` verb prints its payload as ONE compact line FIRST, then
 * `_auto_sync()` chatter follows on the same stdout. Parse that first line:
 * the chatter can itself contain braces (paths, dict-ish log lines), which
 * would defeat a scan-to-the-last-`}` heuristic. `parseCliJson` stays as the
 * fallback for older/pretty-printed payloads. Null when nothing parses.
 */
export function parseCmdPayload<T extends object>(output: string): T | null {
	const firstLine = (output ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith("{"));
	if (firstLine) {
		try {
			const payload = JSON.parse(firstLine) as T;
			if (payload && typeof payload === "object") return payload;
		} catch {
			/* pretty-printed payload — fall through to the tolerant parser */
		}
	}
	try {
		const payload = parseCliJson<T>(output);
		return payload && typeof payload === "object" ? payload : null;
	} catch {
		return null;
	}
}

/** A failing `hub` command still prints its JSON payload, so the raw output is
 *  `{"…": null, "errors": ["…"]}`. Show the first error rather than dumping the
 *  object (or the whole sync log) at the user.
 *
 *  When the payload carries nothing better, fall back to `errorHeadline` rather
 *  than the raw text: `output` is stdout+stderr concatenated, ANSI escapes and
 *  all, and hub.py leads with advisories and success ticks. Pass `streams` when
 *  you have them so stderr can be preferred; without them stdout-shaped rules
 *  apply to the whole blob, which is still strictly better than dumping it. */
export function cliErrorMessage(output: string, streams?: CliStreams): string {
	const payload = parseCmdPayload<{ errors?: unknown; error?: unknown }>(
		output,
	);
	const errors = payload?.errors;
	if (Array.isArray(errors)) {
		const first = errors.find(
			(e): e is string => typeof e === "string" && e.trim().length > 0,
		);
		if (first) return first;
	}
	if (typeof errors === "string" && errors.trim()) return errors.trim();
	// The source verbs report ONE `error` string, not an `errors` list.
	if (typeof payload?.error === "string" && payload.error.trim()) {
		return payload.error.trim();
	}
	return errorHeadline(streams ?? { stdout: output }, "the command failed");
}

/** Toast-ready text for a caught error. Delegates to `errorDetail`, so a
 *  `HubCommandError` contributes its headline (not "HubCommandError: …") and
 *  any ANSI in a plain Error's message is stripped. */
export function errText(err: unknown): string {
	return errorDetail(err).headline;
}

const AUTO_SYNC_MARKER = /the mutation itself succeeded\s*$/;

/** Read the non-fatal sync tail emitted after a registry mutation. */
export function parseAutoSyncTail(streams: CliStreams): {
	partial: boolean;
	headline: string | null;
} {
	const stderrLines = cliLines(streams.stderr);
	const marker = stderrLines.find((line) => AUTO_SYNC_MARKER.test(line));
	if (!marker) return { partial: false, headline: null };

	const remainingStderrLines = stderrLines.filter((line) => line !== marker);
	const stderr = remainingStderrLines
		.filter((line) => !/^(?:[!⚠✓✔]\s)/.test(line.trim()))
		.join("\n");
	const detail = marker.match(
		/auto-sync failed:\s*(.*?)\s+—\s+the mutation itself succeeded$/,
	)?.[1];
	return {
		partial: true,
		headline: errorHeadline(
			{ stdout: streams.stdout ?? "", stderr },
			detail || "Sync did not finish",
		),
	};
}

/** `hub bundle new|update <n> --json` — the payload lands BEFORE the auto-sync
 *  chatter, so it is readable even when the command exits non-zero. */
export interface BundleCmdPayload {
	bundle?: {
		name?: string;
		skills?: string[];
		playbook?: import("@/types").PlaybookSection[];
		description?: string;
		icon?: string;
		scope?: string;
		source?: string | null;
	} | null;
	created?: boolean;
	changed?: boolean;
	/** Non-fatal notes from a write that SUCCEEDED — skills dropped because the
	 *  source doesn't own them, a linked bundle sitting at `scope: global`, …
	 *  The same lines go to stderr, so stdout stays payload-first. Always
	 *  present on success; empty when there is nothing to say. */
	warnings?: string[];
	errors?: unknown;
}

/** The warning lines of a landed bundle write, joined into one toast body.
 *  Empty string when the write had nothing to flag (the common case). */
export function bundleWarningText(p: BundleCmdPayload | null): string {
	return (p?.warnings ?? [])
		.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
		.map((w) => w.trim())
		.join(" · ");
}

/** Minimal slice of `useToast()` — keeps this module free of React. */
interface WarningToaster {
	push(t: {
		kind?: "info";
		title: string;
		body?: string;
		duration?: number;
	}): void;
}

/**
 * Surface a landed write's `warnings` verbatim, in ONE toast.
 *
 * The write succeeded, so this is not an error; it is held on screen for the
 * error dwell time (6s) because a dropped skill or a global-scope link is
 * something the user has to act on later, not a status blip.
 */
export function showBundleWarnings(
	toast: WarningToaster,
	payload: BundleCmdPayload | null,
): void {
	const body = bundleWarningText(payload);
	if (!body) return;
	const many = (payload?.warnings ?? []).length > 1;
	toast.push({
		kind: "info",
		title: many ? "Bundle warnings" : "Bundle warning",
		body,
		duration: 6000,
	});
}

/**
 * A bundle new/update write landed when the payload carries BOTH the resulting
 * bundle AND its outcome flag. A failure payload is `{"bundle": null, …}`, so
 * the `bundle != null` half is what keeps a refusal from being mistaken for a
 * doctor warning — an outcome flag alone is not proof the registry moved.
 */
export function bundleWriteLanded(p: BundleCmdPayload): boolean {
	if (p.bundle == null) return false;
	return p.created === true || typeof p.changed === "boolean";
}

/** `hub bundle delete <n> --json` — `{"deleted": <name>, "errors": []}`, or
 *  `{"deleted": null, …}` on failure / dry-run. */
export interface BundleDeletePayload {
	deleted?: string | null;
	dry_run?: boolean;
	would_unassign?: string[];
	errors?: unknown;
}

/** The delete landed only when the CLI names what it removed. A dry-run
 *  (`deleted: null`) is explicitly NOT a landed write. */
export function bundleDeleteLanded(p: BundleDeletePayload): boolean {
	return typeof p.deleted === "string" && p.deleted.length > 0;
}

/**
 * Run a hub command whose non-zero exit MAY be a consequence GATE rather than
 * a failure (I1/A4 — `ships_with`'s two-phase provisioning): `hub enable
 * <skill> --project <p> --json` prints its `needs_provisioning` payload
 * BEFORE exiting 2 when the skill ships companions and neither
 * `--with-companions` nor `--skill-only` was passed. `T` is the full JSON
 * shape the verb prints on that path (e.g. `{ needs_provisioning?:
 * NeedsCompanions }`).
 *
 * Discriminates on payload PRESENCE, not exit code: `hub_cmd` has no exit
 * code of its own (only `success`), and `hub enable`'s contract (A4) is that
 * the ONLY time it prints a `--json` payload on a non-zero exit is this gate
 * — an ordinary failure (unknown skill, bad project) exits non-zero with
 * plain text and no payload, so it still throws below exactly as
 * `runRegistryWrite` does. This is what lets `hubCmd.ts` stay untouched.
 */
export async function runWithGate<T extends object>(
	args: string[],
): Promise<{ gated: T | null; payload: T | null }> {
	const res = await hubCmd(args);
	const payload = parseCmdPayload<T>(res.output);
	if (!res.success) {
		if (payload) return { gated: payload, payload };
		throw new Error(cliErrorMessage(res.output, hubStreams(res)));
	}
	return { gated: null, payload };
}

/**
 * Run a hub command that writes the registry and THEN auto-syncs.
 *
 * The auto-sync doctor exits non-zero on a danger finding, so `hub_cmd` reports
 * `success: false` even though the registry write DID land. `landed(payload)`
 * is the proof it landed; in that case the non-zero exit is a sync WARNING, not
 * a failure — telling the user nothing happened would be a lie about the
 * registry (and would strand a dialog open on a change that shipped).
 *
 * Throws with the CLI's own first error (never the raw log) on a real failure.
 */
export async function runRegistryWrite<T extends object>(
	args: string[],
	landed: (payload: T) => boolean,
): Promise<{ payload: T | null; warning: string | null }> {
	// Through the shared runner, so a failure keeps its stdout/stderr split and
	// the fallback message can prefer stderr like every other failure surface.
	const res = await hubCmd(args);
	const payload = parseCmdPayload<T>(res.output);
	if (!res.success) {
		const message = cliErrorMessage(res.output, hubStreams(res));
		if (!payload || !landed(payload)) {
			throw new Error(message);
		}
		return { payload, warning: message };
	}
	return { payload, warning: null };
}
