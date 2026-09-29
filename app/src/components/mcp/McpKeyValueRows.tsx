import { useState } from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { RiskBadge } from "@/components/RiskBadge";
import type { UseMcpDraft } from "@/hooks/useMcpDraft";
import { literalSecretKeysOf, refNames } from "@/lib/mcpContract";

export interface McpKeyValueRowsProps {
	draft: UseMcpDraft;
	readOnly: boolean;
	/** `env` for stdio, `headers` for http/sse (design §4.3 — one row
	 *  component, different heading and key placeholder). */
	kind: "headers" | "env";
}

const HEADING: Record<"headers" | "env", string> = {
	headers: "CREDENTIALS · HEADERS",
	env: "CREDENTIALS · ENVIRONMENT",
};
const KEY_PLACEHOLDER: Record<"headers" | "env", string> = {
	headers: "Header-Name",
	env: "ENV_VAR",
};
const EMPTY_LABEL: Record<"headers" | "env", string> = {
	headers: "No headers.",
	env: "No environment variables.",
};
const ADD_LABEL: Record<"headers" | "env", string> = {
	headers: "Add header",
	env: "Add variable",
};

/** CREDENTIALS — the one place the flow deliberately slows down (D2, §4.3).
 *  Each row's value renders one of three ways, decided by the value itself: a
 *  `${VAR}` reference (editable text + a ring chip), a literal that trips
 *  `literalSecretKeysOf` (masked before it reaches the DOM, `RiskBadge`, and a
 *  "use a reference" button), or a plain value. */
export function McpKeyValueRows({ draft, readOnly, kind }: McpKeyValueRowsProps) {
	const { spec, addHeader, removeHeader, addEnv, removeEnv, replaceWithRef } = draft;
	const values = (kind === "headers" ? spec.headers : spec.env) ?? {};
	const keys = Object.keys(values);
	const literalKeys = new Set(literalSecretKeysOf(spec));
	const [draftKey, setDraftKey] = useState("");
	const [draftValue, setDraftValue] = useState("");

	function setValue(key: string, value: string) {
		if (kind === "headers") addHeader(key, value);
		else addEnv(key, value);
	}

	function removeValue(key: string) {
		if (kind === "headers") removeHeader(key);
		else removeEnv(key);
	}

	function commitNewRow() {
		const key = draftKey.trim();
		if (!key) return;
		setValue(key, draftValue);
		setDraftKey("");
		setDraftValue("");
	}

	return (
		<div className="mcp-block" data-block="credentials">
			<SectionHeader label={HEADING[kind]} />
			<div className="mcp-kv-rows">
				{keys.length === 0 && <div className="mcp-block-note">{EMPTY_LABEL[kind]}</div>}
				{keys.map((key) => {
					const value = values[key];
					const refs = refNames(value);
					const isLiteralSecret = literalKeys.has(key);
					return (
						<div className="mcp-kv-row" key={key}>
							<div className="mcp-kv-row-main">
								<input
									type="text"
									className="text-mono mcp-kv-key"
									value={key}
									readOnly
									disabled={readOnly}
									aria-label={`${kind === "headers" ? "Header" : "Variable"} name`}
								/>
								<input
									type="text"
									className="text-mono mcp-kv-value"
									value={isLiteralSecret ? "••••••••" : value}
									readOnly={readOnly || isLiteralSecret}
									disabled={readOnly}
									aria-label={`${key} value`}
									onChange={(e) => {
										if (!isLiteralSecret) setValue(key, e.target.value);
									}}
								/>
								{refs.map((ref) => (
									<span
										key={ref}
										className="mcp-ref-chip"
										title={`Read from the ${ref} environment variable at run time.`}
									>
										<Icon name="link" size={12} />
										{"${" + ref + "}"}
									</span>
								))}
								{isLiteralSecret && (
									// S5: the full sentence lives once, on the always-visible
									// `.mcp-kv-detail` line below — the badge's hover tooltip
									// stays short so the two don't read as a stutter.
									<RiskBadge code="LITERAL" severity="warning" explanation="Stored in plain text." />
								)}
								{isLiteralSecret && !readOnly && (
									<Button variant="ghost" size="sm" onClick={() => replaceWithRef(key)}>
										{"Use a ${…} reference"}
									</Button>
								)}
								{!readOnly && (
									<Button
										variant="ghost"
										size="sm"
										icon="x"
										aria-label={`Remove ${key}`}
										onClick={() => removeValue(key)}
									/>
								)}
							</div>
							{isLiteralSecret && (
								<div className="mcp-kv-detail">
									This value is written into every harness config file in plain text. It is also
									excluded from backups.
								</div>
							)}
						</div>
					);
				})}
				{!readOnly && (
					<div className="mcp-kv-row">
						<div className="mcp-kv-row-main">
							<input
								type="text"
								className="text-mono mcp-kv-key"
								placeholder={KEY_PLACEHOLDER[kind]}
								value={draftKey}
								onChange={(e) => setDraftKey(e.target.value)}
							/>
							<input
								type="text"
								className="text-mono mcp-kv-value"
								placeholder="value"
								value={draftValue}
								onChange={(e) => setDraftValue(e.target.value)}
							/>
							<Button variant="ghost" size="sm" icon="plus" onClick={commitNewRow} disabled={!draftKey.trim()}>
								{ADD_LABEL[kind]}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
