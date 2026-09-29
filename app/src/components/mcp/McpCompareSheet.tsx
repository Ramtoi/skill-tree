import { useState } from "react";
import { Sheet } from "@/components/Modal";
import { LoadingButton } from "@/components/loading";
import { Button } from "@/components/Button";
import { PathText } from "@/components/PathText";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import {
	adoptionConsequences,
	endpointLabel,
	maskQueryParam,
	optionRenamedTo,
	suggestRef,
} from "@/lib/mcpContract";
import type {
	McpCandidate,
	McpCandidateOption,
	McpReconcileScopeKind,
	McpScope,
	McpSpec,
} from "@/lib/mcpContract";
import {
	isUrlUserinfoLiteral,
	literalQueryParams,
	literalWarningKey,
} from "@/components/mcp/DetectedMcpServers";

/** (F4/§2.7) `endpointLabel` returns the URL verbatim — a credential value
 *  must never reach the DOM. Masks the option's OWN userinfo (`user:pw@`)
 *  when the candidate carries that warning, and every literal query param
 *  (W7 — a candidate can carry more than one `url.query:<param>` warning)
 *  when it carries one; every OTHER option's URL is left alone (there is
 *  nothing to strip when it never had a credential). A malformed URL falls
 *  back to the raw label rather than throwing — endpoint text is
 *  informational here, not validated. */
function redactedOptionEndpoint(spec: McpSpec, userinfoLiteral: boolean, queryParams: string[]): string {
	const raw = endpointLabel(spec);
	if (!raw || (spec.transport !== "http" && spec.transport !== "sse")) return raw;
	if (!userinfoLiteral && queryParams.length === 0) return raw;
	try {
		let masked = raw;
		for (const param of queryParams) masked = maskQueryParam(masked, param);
		if (userinfoLiteral) {
			const u = new URL(masked);
			u.username = "";
			u.password = "";
			masked = u.toString();
		}
		return masked;
	} catch {
		return raw;
	}
}

const SCOPE_LABEL: Record<McpScope, string> = {
	user: "user",
	local: "local",
	project: "project",
	global: "global",
};

/** N1: a scope word this build does not recognize (a differently-versioned
 *  `hub`) renders itself rather than `undefined` — the same fallback pattern
 *  `deliveryReasonLine`/`unsupportedReasonLine` already use. */
function scopeWord(scope: McpScope): string {
	return SCOPE_LABEL[scope] ?? scope;
}

/** `<Harness> · <scope>` — never a dangling separator; the F5 registry
 *  pseudo-option (`harness === "registry"`) reads `Skill Tree's own record`
 *  with no scope and no separator at all (grill findings 5/6). */
function cardLabel(option: McpCandidateOption): string {
	if (option.harness === "registry") return "Skill Tree's own record";
	if (!option.scope) return harnessLabel(option.harness);
	return `${harnessLabel(option.harness)} · ${scopeWord(option.scope)}`;
}

/** S1: this sheet's entire purpose is showing what differs between options —
 *  true when at least two options disagree on `get`'s value. `< 2` options
 *  never differs (nothing to compare). */
function anyDiffers(options: McpCandidateOption[], get: (o: McpCandidateOption) => string): boolean {
	if (options.length < 2) return false;
	const first = get(options[0]);
	return options.some((o) => get(o) !== first);
}

/** The mark itself: a `--ctx` tick + weight change on a differing value —
 *  the context channel ("where am I, for this content"), never a status
 *  color, since disagreeing is not itself right or wrong. */
const DIFFERING_STYLE = { color: "var(--ctx)", fontWeight: 600 } as const;

export interface McpCompareSheetProps {
	open: boolean;
	onClose: () => void;
	candidate: McpCandidate | null;
	/** Piped through one `mcp_reconcile_apply` decision, harness- and
	 *  scope-qualified (D review W4: an option is identified by
	 *  `(harness, scope)`, so both must ride in the decision). `opts` carries
	 *  the literal-secret hatch a card's own action chose (E3 rev 2 §2.4). */
	onAdopt: (
		cand: McpCandidate,
		option: McpCandidateOption,
		opts?: { allowLiteral?: boolean; replaceWithRef?: boolean },
	) => Promise<void>;
	/** W3: the reconcile scope this sheet's own `onAdopt` will actually apply
	 *  into — feeds `adoptionConsequences`' scope rule (E3 rev 2 §2.3).
	 *  `useMcpDecisions.ts` hardcodes `--global` today, so every caller passes
	 *  (or omits, defaulting to) `"global"`; the prop exists so the copy stays
	 *  correct the moment a project-scope reconcile caller shows up. */
	scopeKind?: McpReconcileScopeKind;
}

/**
 * The `conflict` comparison sheet (design D5/§4.2): one column per option,
 * each labelled by harness AND scope (D review W4 — Claude's local vs
 * project copies can share a harness), the spec shown as header/env **keys
 * only** (F4: a credential value never reaches the DOM), and one "Adopt this
 * one" button per column. E3 rev 2 §2.4 adds literal-aware card actions (the
 * card reuses `literalWarningKey`/`bareKeyOf` from `DetectedMcpServers.tsx`
 * rather than the raw warning key, grill finding 11), a per-card consequence
 * line (§2.3's scope rule), and the F5 registry pseudo-option branch.
 */
export function McpCompareSheet({
	open,
	onClose,
	candidate,
	onAdopt,
	scopeKind = "global",
}: McpCompareSheetProps) {
	const [pending, setPending] = useState<string | null>(null);

	if (!candidate) return null;
	const cand = candidate;
	const literalKey = literalWarningKey(cand);
	const userinfoLiteral = isUrlUserinfoLiteral(cand);
	const queryParams = literalQueryParams(cand);
	const varName = literalKey ? suggestRef(cand.name, literalKey, "").varName : null;
	// W2: the same reason line the band renders per-row (E3 rev 2 §2.7),
	// shown ONCE above the option grid — the sheet never explained what
	// "anyway" costs.
	const literalReasonLine = literalKey
		? userinfoLiteral
			? "The URL carries a username and password."
			: `${literalKey} carries a token in plain text.`
		: null;

	async function adopt(option: McpCandidateOption, opts?: { allowLiteral?: boolean; replaceWithRef?: boolean }) {
		const key = `${option.harness}:${option.scope}:${option.file}`;
		if (pending) return;
		setPending(key);
		try {
			await onAdopt(cand, option, opts);
			onClose();
		} finally {
			setPending(null);
		}
	}

	// S1: mark exactly the rows that actually differ — the one thing this
	// sheet exists to show. Headers/env compare by their KEY SET (F4: values
	// never render here at all, so a value-only difference is invisible by
	// design and correctly not marked). W1: the endpoint compares over the
	// SAME REDACTED string the card renders — comparing the raw value marks
	// a difference the user cannot see (and the real CLI already redacts
	// `options[].spec.url`, so two copies differing only in a credential
	// arrive byte-EQUAL here).
	const transportDiffers = anyDiffers(cand.options, (o) => o.spec.transport ?? "stdio");
	const endpointDiffers = anyDiffers(
		cand.options,
		(o) => redactedOptionEndpoint(o.spec, userinfoLiteral, queryParams) || "—",
	);
	const headersDiffer = anyDiffers(cand.options, (o) =>
		Object.keys(o.spec.headers ?? {}).sort().join(","),
	);
	const envDiffers = anyDiffers(cand.options, (o) => Object.keys(o.spec.env ?? {}).sort().join(","));
	// W1: every rendered field agrees once credentials are masked — the two
	// cards are visually identical, so say so instead of showing nothing.
	const nothingVisiblyDiffers =
		cand.options.length >= 2 && !transportDiffers && !endpointDiffers && !headersDiffer && !envDiffers;
	// W8: `nothingVisiblyDiffers` fires on ANY invisible difference — headers/
	// env compare by KEY SET ONLY (S1: a value-only difference, e.g.
	// `env.FOO: "a"` vs `"b"`, is invisible by design and correctly not
	// marked), which is not necessarily a credential. Only say "credential"
	// when the candidate actually carries a literal-secret warning; otherwise
	// name the real, honest reason — a value the sheet does not show.
	const invisibleDifferenceLine = nothingVisiblyDiffers
		? literalKey
			? "The two copies differ only in a credential value."
			: "These copies differ only in a value Skill Tree does not show."
		: null;

	return (
		<Sheet
			open={open}
			onClose={onClose}
			title={`${candidate.name} · configured in ${candidate.options.length} places`}
			width={720}
			aria-label={`${candidate.name} comparison`}
		>
			{literalReasonLine && (
				<p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--amber)" }}>
					{literalReasonLine}
				</p>
			)}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: `repeat(${Math.max(candidate.options.length, 1)}, minmax(200px, 1fr))`,
					gap: 12,
				}}
			>
				{candidate.options.map((option) => {
					const key = `${option.harness}:${option.scope}:${option.file}`;
					const headerKeys = Object.keys(option.spec.headers ?? {});
					const envKeys = Object.keys(option.spec.env ?? {});
					const renamedTo = optionRenamedTo(cand, option);
					const consequences = adoptionConsequences(cand, option, scopeKind);
					const busy = pending === key;
					const disabledOther = pending !== null && pending !== key;
					return (
						<div
							key={key}
							data-testid="mcp-compare-option"
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 8,
								padding: 12,
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-sm)",
								background: "var(--bg-1)",
							}}
						>
							<div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg-strong)" }}>
								{cardLabel(option)}
							</div>
							{option.file && (
								<PathText
									path={option.file}
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 11,
										color: "var(--fg-mute)",
										wordBreak: "break-word",
									}}
								/>
							)}
							<div style={{ fontSize: 11.5, color: "var(--fg-mid)" }}>
								<div>
									transport:{" "}
									<span style={transportDiffers ? DIFFERING_STYLE : undefined}>
										{option.spec.transport ?? "stdio"}
									</span>
								</div>
								<div>
									endpoint:{" "}
									<span style={endpointDiffers ? DIFFERING_STYLE : undefined}>
										{redactedOptionEndpoint(option.spec, userinfoLiteral, queryParams) || "—"}
									</span>
								</div>
								{headerKeys.length > 0 && (
									<div>
										headers:{" "}
										<span style={headersDiffer ? DIFFERING_STYLE : undefined}>
											{headerKeys.join(", ")}
										</span>
									</div>
								)}
								{envKeys.length > 0 && (
									<div>
										env:{" "}
										<span style={envDiffers ? DIFFERING_STYLE : undefined}>
											{envKeys.join(", ")}
										</span>
									</div>
								)}
							</div>
							{!literalKey && (
								<LoadingButton
									variant="primary"
									size="sm"
									loading={busy}
									loadingLabel="Adopting…"
									disabled={disabledOther}
									onClick={() => void adopt(option)}
								>
									{renamedTo ? `Adopt as ${renamedTo}` : "Adopt this one"}
								</LoadingButton>
							)}
							{literalKey && !userinfoLiteral && (
								<>
									<LoadingButton
										variant="primary"
										size="sm"
										loading={busy}
										loadingLabel="Adopting…"
										disabled={disabledOther}
										onClick={() => void adopt(option, { replaceWithRef: true })}
									>
										{`Adopt as \${${varName}}`}
									</LoadingButton>
									<Button
										variant="ghost"
										size="sm"
										busy={busy}
										disabled={disabledOther}
										onClick={() => void adopt(option, { allowLiteral: true })}
									>
										Adopt anyway
									</Button>
								</>
							)}
							{literalKey && userinfoLiteral && (
								<LoadingButton
									variant="ghost"
									size="sm"
									loading={busy}
									loadingLabel="Adopting…"
									disabled={disabledOther}
									onClick={() => void adopt(option, { allowLiteral: true })}
								>
									Adopt anyway
								</LoadingButton>
							)}
							{/* Non-literal: the button text itself already says "Adopt as
							    <slug>" — a separate line here would just repeat it. A
							    literal keeps its "Adopt as ${VAR}" chip, so the rename
							    needs its own line (E3 rev 2 §2.6). */}
							{literalKey && renamedTo && (
								<p style={{ margin: 0, fontSize: 11, color: "var(--fg-mute)" }}>
									registered as{" "}
									<code style={{ fontFamily: "var(--font-mono)" }}>{renamedTo}</code>
								</p>
							)}
							{consequences.map((c) => (
								<p key={`${c.verb}:${c.place}`} style={{ margin: 0, fontSize: 11, color: "var(--fg-mute)" }}>
									{c.verb}: {c.place}
								</p>
							))}
						</div>
					);
				})}
			</div>
			{/* W1: after redaction, two copies can be byte-identical (the real
			    CLI already strips the credential from every option's spec) —
			    say so instead of rendering two unmarked, visually identical
			    cards with nothing explaining why this is even a conflict.
			    W8: only claim a "credential" when one is actually present. */}
			{invisibleDifferenceLine && (
				<p style={{ margin: "12px 0 0", fontSize: 11.5, color: "var(--fg-mute)" }}>
					{invisibleDifferenceLine}
				</p>
			)}
		</Sheet>
	);
}
