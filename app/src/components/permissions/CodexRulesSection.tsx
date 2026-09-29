import type { CSSProperties } from "react";
import { Button } from "../Button";
import { useToast } from "../Toast";
import { KIND_META } from "./PermissionsPanels";
import {
	bashPrefixTokens,
	codexDecision,
	type NormalizedPermissions,
	type Rule,
	type RuleKind,
} from "@/types/permissions";

export interface CodexRuleRow {
	tokens: string[];
	decision: "allow" | "prompt" | "forbidden";
	kind: RuleKind;
}

export interface CodexRuleLinesResult {
	lines: string[];
	rows: CodexRuleRow[];
	skipped: number;
}

/**
 * Pure Starlark-line + table-row builder for the Codex rules file preview.
 * Mirrors the backend's `skill-hub.rules` generation (`allow→allow`,
 * `ask→prompt`, `deny→forbidden`): only a bounded Bash prefix
 * (`bashPrefixTokens`) translates, everything else counts toward `skipped`.
 * Order matches the file hub generates: allow, deny, ask.
 */
export function codexRuleLines(
	draft: NormalizedPermissions,
): CodexRuleLinesResult {
	const rules: Rule[] = [...draft.allow, ...draft.deny, ...draft.ask];
	const rows: CodexRuleRow[] = [];
	const lines: string[] = [];
	let skipped = 0;
	for (const r of rules) {
		const tokens = bashPrefixTokens(r.pattern);
		if (tokens === null) {
			skipped += 1;
			continue;
		}
		const decision = codexDecision(r.kind);
		rows.push({ tokens, decision, kind: r.kind });
		const pat = `[${tokens.map((t) => JSON.stringify(t)).join(", ")}]`;
		lines.push(
			`prefix_rule(pattern = ${pat}, decision = ${JSON.stringify(decision)})`,
		);
	}
	return { lines, rows, skipped };
}

/**
 * The Codex rules file body: one row per translatable rule instead of a
 * `<pre>` of Starlark (the old preview overflowed the panel horizontally).
 * The exact lines stay one click away via Copy.
 */
export function CodexRulesSection({
	draft,
}: {
	draft: NormalizedPermissions;
}) {
	const toast = useToast();
	const { rows, lines } = codexRuleLines(draft);

	async function copyStarlark() {
		try {
			await navigator.clipboard.writeText(
				lines.join("\n") + (lines.length ? "\n" : ""),
			);
			toast.success(`Copied ${lines.length} rule${lines.length === 1 ? "" : "s"}`);
		} catch {
			/* clipboard unavailable (e.g. test env) — no-op */
		}
	}

	return (
		<div data-testid="codex-rules-preview">
			{rows.length > 0 ? (
				<>
					<div className="perm-codex-table">
						{rows.map((row, i) => (
							<div className="perm-codex-row" key={i}>
								<code>{row.tokens.join(" ")}</code>
								<span
									className="perm-codex-decision"
									data-kind={row.kind}
									style={
										{ "--accent": KIND_META[row.kind].accent } as CSSProperties
									}
								>
									{row.decision}
								</span>
							</div>
						))}
					</div>
					<Button
						variant="ghost"
						size="sm"
						icon="copy"
						onClick={() => void copyStarlark()}
					>
						Copy Starlark
					</Button>
				</>
			) : (
				<div className="perm-side-hint">
					No bounded Bash prefix to translate. Example:{" "}
					<code>Bash(npm:*)</code>.
				</div>
			)}
		</div>
	);
}
