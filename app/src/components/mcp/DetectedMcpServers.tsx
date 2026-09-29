import { useEffect, useState } from "react";
import { LoadingButton } from "@/components/loading";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { RiskBadge } from "@/components/RiskBadge";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import {
	bareKeyOf,
	candidateIsRenamed,
	endpointLabel,
	joinLabels,
	maskQueryParam,
	placeLabel,
	suggestRef,
	warningLine,
} from "@/lib/mcpContract";
import type { McpCandidate, McpCandidateOption } from "@/lib/mcpContract";

const FOLD_LS_KEY = "st:library:mcp-unsupported";

/** E3 rev 2 §2.6's complete unsupported-reason copy map. Split-on-first-`:`
 *  mirrors the delivery-row `<reason>:<detail>` convention (INTERFACES §4);
 *  the words that carry no detail see `detail: null`. Unknown words fall
 *  back rather than render nothing (E1 review W1's lesson, applied here). */
function unsupportedReasonLine(cand: McpCandidate): string {
	const reason = cand.reason;
	if (!reason) return "Skill Tree does not recognise this entry.";
	const idx = reason.indexOf(":");
	const word = idx === -1 ? reason : reason.slice(0, idx);
	const detail = idx === -1 ? null : reason.slice(idx + 1);
	switch (word) {
		case "ws_transport":
			return "WebSocket servers are Claude Code only.";
		case "oauth_block":
			return "This server signs in through the harness. Adopt it there.";
		case "headers_helper":
			return "This server gets its headers from a script Skill Tree cannot run.";
		case "unknown_shape":
			return "Skill Tree does not recognise this entry.";
		case "local_scope_unregistered_project":
			// S4: the period sits OUTSIDE the ternary — with a detail the
			// sentence must still end in one ("...track: /path.").
			return `This server belongs to a folder Skill Tree does not track${detail ? `: ${detail}` : ""}.`;
		case "no_global_target":
			return "Skill Tree has no user-level MCP file for this harness. Configure it on a project instead.";
		case "invalid_name":
			return `${cand.name} cannot become a skill name even after lowercasing.`;
		case "name_taken":
			return `${detail ?? cand.name} is already a different skill in your registry.`;
		case "transport_conflict":
			return "Has both a command and a URL. Fix the native entry first.";
		case "no_endpoint":
			return "No URL.";
		case "malformed_field":
			return `${detail ?? "This field"} is not the shape hub expects.`;
		case "disabled_upstream":
			return "Disabled in its native config; hub would re-enable it.";
		case "unknown_transport":
			return `Transport ${detail ?? "?"} is not one hub speaks (stdio, http, sse).`;
		case "unreadable_file":
			return `${detail ?? "That file"} could not be read.`;
		case "malformed_url":
			return "The URL must be absolute (http or https).";
		case "unsupported_url_scheme":
			return `${detail ?? "That"} URLs cannot be an MCP endpoint.`;
		case "duplicate_header":
			return `Header ${detail ?? "?"} appears twice.`;
		default:
			return "Skill Tree does not recognise this entry.";
	}
}

/** (W5) `endpointLabel` returns the URL verbatim, query string and all — the
 *  right call for a shared helper, but wrong for THIS render site when a
 *  `literal_secret:url.query:<param>` warning says that query string carries
 *  a plaintext credential. Masks each such param's value before the endpoint
 *  ever reaches the DOM; a malformed URL falls back to the raw label rather
 *  than throwing (endpoint text is informational, not validated). */
function redactedEndpoint(cand: McpCandidate): string {
	const endpoint = cand.spec ? endpointLabel(cand.spec) : "";
	const queryWarnings = cand.warnings.filter((w) => w.startsWith("literal_secret:url.query:"));
	const hasUserinfo = cand.warnings.includes("literal_secret:url.userinfo");
	if (queryWarnings.length === 0 && !hasUserinfo) return endpoint;
	try {
		let masked = endpoint;
		for (const w of queryWarnings) {
			const { bare } = bareKeyOf(w.slice("literal_secret:".length));
			// N3: `maskQueryParam` builds the masked query string by hand — a
			// `URLSearchParams.set` round-trip would percent-encode the bullet
			// characters into mojibake.
			masked = maskQueryParam(masked, bare);
		}
		// E3 rev 2 §2.7 (catalogue U01): a URL carrying `user:pw@` is itself
		// the credential — never let it reach the DOM verbatim.
		if (hasUserinfo) {
			const u = new URL(masked);
			u.username = "";
			u.password = "";
			masked = u.toString();
		}
		return masked;
	} catch {
		return endpoint;
	}
}

/** `<transport> · <endpoint> · found in <harness label(s)>`, plus a
 *  `· local scope` suffix when a Claude local-scope source is among the
 *  candidate's sources (M7). */
function sourceLine(cand: McpCandidate): string {
	const transport = cand.spec?.transport ?? "stdio";
	const endpoint = redactedEndpoint(cand);
	const labels = [...new Set(cand.sources.map((s) => harnessLabel(s.harness)))];
	const local = cand.sources.some((s) => s.scope === "local");
	const parts = [transport, endpoint, `found in ${joinLabels(labels)}`].filter(Boolean);
	return parts.join(" · ") + (local ? " · local scope" : "");
}

/** `<Place A> and <Place B> configure this differently.` (E3 rev 2 §2.6) —
 *  named places, not a bare count (grill finding 14). */
function conflictPlacesLine(cand: McpCandidate): string {
	const places = cand.options.map((o) => placeLabel(o.harness, o.scope));
	return `${joinLabels(places)} configure this differently.`;
}

/** (W5) Runs the `literal_secret:<Key>` warning's key through `bareKeyOf`
 *  before it ever reaches display or `suggestRef` — a URL-embedded token's
 *  key arrives as the raw `url.query:<param>` token (INTERFACES §1
 *  `secret_keys_in_spec`), which is neither a real header/env name nor safe
 *  to show verbatim. `url.userinfo` (E3 rev 2 §2.7) passes through
 *  unchanged — `bareKeyOf` only strips the `url.query:` prefix. Exported so
 *  the compare sheet reuses the exact same read (grill finding 11). */
export function literalWarningKey(cand: McpCandidate): string | null {
	const w = cand.warnings.find((x) => x.startsWith("literal_secret:"));
	if (!w) return null;
	return bareKeyOf(w.slice("literal_secret:".length)).bare;
}

/** A URL carrying `user:pw@` (E3 rev 2 §2.7, catalogue U01) is a literal
 *  credential with no `${VAR}` replacement offered — only `Adopt anyway`. */
export function isUrlUserinfoLiteral(cand: McpCandidate): boolean {
	return cand.warnings.includes("literal_secret:url.userinfo");
}

/** Every bare query-param name carrying a `literal_secret:url.query:<param>`
 *  warning — `[]` when there is none. `literalWarningKey` above already
 *  strips the `url.query:` prefix via `bareKeyOf` for the FIRST such warning
 *  (the one line the row/card names), so a caller that needs to know WHICH
 *  query params to mask back into a URL — potentially more than one (W7: a
 *  candidate can carry two query-string secrets) — reads this instead. */
export function literalQueryParams(cand: McpCandidate): string[] {
	return cand.warnings
		.filter((w) => w.startsWith("literal_secret:url.query:"))
		.map((w) => w.slice("literal_secret:url.query:".length));
}

export interface DetectedMcpServersProps {
	candidates: McpCandidate[];
	onAdopt: (cand: McpCandidate) => Promise<void>;
	onAdoptAsRef: (cand: McpCandidate) => Promise<void>;
	onAdoptAnyway: (cand: McpCandidate) => Promise<void>;
	onKeep: (cand: McpCandidate) => Promise<void>;
	onCompare: (cand: McpCandidate) => void;
}

/**
 * The Library's "Detected MCP servers" band (design D5, M9) — the MCP twin of
 * `ProjectLocalSkills`. Renders one row per `new`/`conflict` candidate;
 * `already_managed`/`stale` never render (the CLI's `kept` list is a
 * separate, name-only array E2 does not surface); `unsupported` candidates
 * fold into one collapsed disclosure so the band does not shout forever about
 * servers nobody can adopt. Renders nothing when no actionable candidate
 * exists — a band with nothing to do is noise on the thousandth run.
 */
export function DetectedMcpServers({
	candidates,
	onAdopt,
	onAdoptAsRef,
	onAdoptAnyway,
	onKeep,
	onCompare,
}: DetectedMcpServersProps) {
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const [unsupportedOpen, setUnsupportedOpen] = useState(false);

	useEffect(() => {
		try {
			setUnsupportedOpen(window.localStorage.getItem(FOLD_LS_KEY) === "1");
		} catch {
			/* localStorage unavailable — stay collapsed */
		}
	}, []);

	function toggleUnsupported() {
		setUnsupportedOpen((cur) => {
			const next = !cur;
			try {
				window.localStorage.setItem(FOLD_LS_KEY, next ? "1" : "0");
			} catch {
				/* best-effort persistence only */
			}
			return next;
		});
	}

	const actionable = candidates.filter((c) => c.status === "new" || c.status === "conflict");
	const unsupported = candidates.filter((c) => c.status === "unsupported");

	if (actionable.length === 0) return null;

	async function run(name: string, action: () => Promise<void>) {
		if (pending.has(name)) return;
		setPending((cur) => new Set(cur).add(name));
		try {
			await action();
		} finally {
			setPending((cur) => {
				const next = new Set(cur);
				next.delete(name);
				return next;
			});
		}
	}

	return (
		<section
			className="loadout-section"
			aria-label="Detected MCP servers"
			data-testid="detected-mcp-servers"
		>
			<h3>
				<Icon name="mcp" size={14} />
				<span style={{ whiteSpace: "nowrap" }}>Detected MCP servers</span>
				<span className="count">{actionable.length}</span>
				<span className="stretch" />
				<span
					style={{
						color: "var(--fg-dim)",
						fontSize: 11,
						fontFamily: "var(--font-mono)",
					}}
				>
					configured natively · not yet in the registry
				</span>
			</h3>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				{actionable.map((cand) => {
					const isPending = pending.has(cand.name);
					const literalKey = literalWarningKey(cand);
					const userinfoLiteral = isUrlUserinfoLiteral(cand);
					const unclaimed = cand.warnings.includes("unclaimed_native_entry");
					const renamed = cand.status === "new" && candidateIsRenamed(cand);
					// The generic warning lines every OTHER row-level line above
					// doesn't already cover (literal/unclaimed/rename all render
					// their own dedicated line or button text instead).
					const extraWarnings = cand.warnings.filter(
						(w) =>
							!w.startsWith("literal_secret:") &&
							w !== "unclaimed_native_entry" &&
							!w.startsWith("renamed_from:"),
					);
					return (
						<div key={cand.name} className="detected-mcp-row" data-status={cand.status}>
							<div style={{ minWidth: 0, flex: 1 }}>
								<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
									<span
										style={{
											fontFamily: "var(--font-mono)",
											fontSize: 13,
											color: "var(--fg-strong)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{cand.name}
									</span>
									{cand.status === "new" ? (
										<Tag color="var(--green)" size="sm">
											NEW
										</Tag>
									) : (
										// S3: the same amber-warning grammar as LITERAL here and
										// the Library's existing CONFLICT badge — a plain Tag was
										// a third visual shape for one channel in one viewport.
										<RiskBadge
											code="DIFFERS"
											severity="warning"
											explanation="Configured in more than one place with different settings. Compare to choose which copy to adopt."
										/>
									)}
									{literalKey && (
										<RiskBadge
											code="LITERAL"
											severity="warning"
											explanation="A credential is written as plain text in the native config. Adopting as ${VAR} keeps the value out of every harness file and out of backups."
										/>
									)}
								</div>
								<p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--fg-mute)" }}>
									{cand.status === "new" ? sourceLine(cand) : conflictPlacesLine(cand)}
								</p>
								{literalKey && (
									<p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--amber)" }}>
										{userinfoLiteral
											? "The URL carries a username and password."
											: `${literalKey} carries a token in plain text.`}
									</p>
								)}
								{literalKey && renamed && (
									<p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--fg-mute)" }}>
										registered as{" "}
										<code style={{ fontFamily: "var(--font-mono)" }}>{cand.name}</code>
									</p>
								)}
								{unclaimed && (
									<p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--fg-mute)" }}>
										Skill Tree has this server but did not write the copy on disk.
									</p>
								)}
								{extraWarnings.map((w) => (
									<p key={w} style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--fg-mute)" }}>
										{warningLine(w, cand.name)}
									</p>
								))}
							</div>
							<div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
								{cand.status === "new" && !literalKey && (
									<LoadingButton
										variant="primary"
										size="sm"
										icon="plus"
										loading={isPending}
										loadingLabel="Adopting…"
										onClick={() => void run(cand.name, () => onAdopt(cand))}
									>
										{renamed ? `Adopt as ${cand.name}` : "Adopt"}
									</LoadingButton>
								)}
								{cand.status === "new" && literalKey && !userinfoLiteral && (
									<>
										<LoadingButton
											variant="primary"
											size="sm"
											loading={isPending}
											loadingLabel="Adopting…"
											onClick={() => void run(cand.name, () => onAdoptAsRef(cand))}
										>
											{`Adopt as \${${suggestRef(cand.name, literalKey, "").varName}}`}
										</LoadingButton>
										<Button
											variant="ghost"
											size="sm"
											busy={isPending}
											onClick={() => void run(cand.name, () => onAdoptAnyway(cand))}
										>
											Adopt anyway
										</Button>
									</>
								)}
								{cand.status === "new" && literalKey && userinfoLiteral && (
									<LoadingButton
										variant="ghost"
										size="sm"
										loading={isPending}
										loadingLabel="Adopting…"
										onClick={() => void run(cand.name, () => onAdoptAnyway(cand))}
									>
										Adopt anyway
									</LoadingButton>
								)}
								{cand.status === "conflict" && (
									<Button variant="soft" size="sm" onClick={() => onCompare(cand)}>
										Compare…
									</Button>
								)}
								<Button
									variant="ghost"
									size="sm"
									busy={isPending}
									onClick={() => void run(cand.name, () => onKeep(cand))}
								>
									Keep native
								</Button>
							</div>
						</div>
					);
				})}
			</div>
			{unsupported.length > 0 && (
				<div className="mcp-unsupported-fold">
					{/* S2: a chevron so this reads as a control, not a status line
					    (aria-expanded already made it correct for assistive tech). */}
					<Button
						variant="ghost"
						size="sm"
						icon={unsupportedOpen ? "chevron-down" : "chevron-right"}
						aria-expanded={unsupportedOpen}
						aria-controls="mcp-unsupported-list"
						onClick={toggleUnsupported}
					>
						{unsupported.length} server{unsupported.length === 1 ? "" : "s"} stay native (why)
					</Button>
					{unsupportedOpen && (
						<ul id="mcp-unsupported-list" className="mcp-unsupported-list">
							{unsupported.map((cand) => (
								<li key={cand.name}>
									<span style={{ fontFamily: "var(--font-mono)" }}>{cand.name}</span>
									{" — "}
									{unsupportedReasonLine(cand)}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}

export type { McpCandidate, McpCandidateOption };
