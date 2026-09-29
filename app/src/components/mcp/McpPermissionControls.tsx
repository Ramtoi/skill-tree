import "@/styles/mcp-permissions.css";
import { useEffect, useMemo, useState } from "react";
import { SearchInput } from "@/components/SearchInput";
import { Field } from "@/components/Field";
import { Button } from "@/components/Button";
import { Select, type SelectOption } from "@/components/Select";
import { harnessSupportsRule, type Capabilities, type NormalizedPermissions } from "@/types/permissions";
import { applyMcpPermissionChanges, mcpChoiceBlocker, mcpRuleIsBroad, mcpRules, mcpTarget, projectMcpDecision, validMcpSegment, type McpPermissionChange, type McpPermissionChoice } from "@/lib/mcpPermissionRules";
import type { McpCatalogTool } from "@/lib/mcpContract";

export interface McpPermissionControlsProps {
	server: string;
	tools: McpCatalogTool[];
	draft: NormalizedPermissions;
	changes: McpPermissionChange[];
	onChange: (change: McpPermissionChange) => void;
	disabled?: boolean;
	otherScopes: NormalizedPermissions[];
	capabilities: Capabilities;
	scopeKind: "global" | "project";
}
const choices: McpPermissionChoice[] = ["default", "allow", "ask", "deny"];
const labels: Record<McpPermissionChoice, string> = { default: "Default", allow: "Allow", ask: "Ask", deny: "Deny" };
function exactName(pattern: string, server: string): string | null {
	const prefix = `mcp__${server}__`;
	const name = pattern.startsWith(prefix) ? pattern.slice(prefix.length) : "";
	return validMcpSegment(name) ? name : null;
}

export function McpPermissionControls({ server, tools, draft, changes, onChange, disabled, otherScopes, capabilities, scopeKind }: McpPermissionControlsProps) {
	const [query, setQuery] = useState("");
	const [manual, setManual] = useState("");
	const [manualRows, setManualRows] = useState<string[]>([]);
	const [manualError, setManualError] = useState<string | null>(null);
	useEffect(() => { setQuery(""); setManual(""); setManualRows([]); setManualError(null); }, [server]);
	const preview = useMemo(() => {
		try { return applyMcpPermissionChanges(draft, changes, scopeKind); }
		catch { return draft; }
	}, [draft, changes, scopeKind]);
	const names = useMemo(() => [...new Set([
		...tools.map((tool) => tool.name).filter(validMcpSegment),
		...[...mcpRules(draft), ...mcpRules(preview)].map((rule) => exactName(rule.pattern, server)).filter((name): name is string => name !== null),
		...manualRows,
	])], [tools, draft, preview, server, manualRows]);
	if (!validMcpSegment(server)) return <p role="alert">This MCP name cannot form an exact permission target. Edit its rules in Permissions.</p>;
	const contextRules = otherScopes.flatMap(mcpRules).filter((rule) => mcpRuleIsBroad(rule, server) || rule.pattern.startsWith(`mcp__${server}__`) || rule.pattern.startsWith("mcp__*"));
	const visible = names.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
	const row = (tool?: string) => {
		const original = projectMcpDecision(draft, server, tool);
		const selected = projectMcpDecision(preview, server, tool).decision;
		const affinity = original.rule?.harnesses ?? null;
		const change = (decision: McpPermissionChoice): McpPermissionChange => ({ server, tool, decision, harnesses: affinity });
		const blocker = (decision: McpPermissionChoice) => mcpChoiceBlocker(preview, otherScopes, change(decision), capabilities, scopeKind);
		const options: SelectOption<McpPermissionChoice>[] = choices.filter((choice) => choice === selected || !blocker(choice)).map((choice) => ({ value: choice, label: labels[choice] }));
		const warning = blocker(selected);
		const supported = selected === "default" ? [] : Object.keys(capabilities).filter((id) =>
			(affinity == null || affinity.includes(id)) && harnessSupportsRule(id, { pattern: mcpTarget(server, tool), kind: selected }, capabilities));
		const title = tools.find((item) => item.name === tool)?.title;
		return <div className="mcp-permission-row" key={tool ?? "all"}>
			<div className="mcp-permission-name"><strong>{tool ?? "All tools"}</strong>{title && title !== tool && <span>{title}</span>}{affinity !== null && <span className="mcp-block-note">Coding tools: {affinity.length ? affinity.join(", ") : "none"}</span>}</div>
			<Select value={selected} options={options} label={`${tool ?? "All tools"} permission`} disabled={disabled || original.ambiguous} onChange={(decision) => onChange(change(decision))} />
			{selected !== "default" && <span className="mcp-block-note">{supported.length ? `Supported: ${supported.join(", ")}` : "No installed coding tool supports this rule in its current scope."}</span>}
			{original.ambiguous && <span className="mcp-block-note">Separate rules have different decisions or coding-tool scopes. Edit them in Permissions.</span>}
			{warning && <span className="mcp-block-note" role="status">{warning}</span>}
		</div>;
	};
	return <div className="mcp-permission-controls">
		<p className="mcp-block-note">Default removes this scope’s rule. Other rules still apply. Deny takes precedence over Ask, then Allow. Choices blocked by stronger rules are unavailable.</p>
		{contextRules.length > 0 && <details className="mcp-block-note"><summary>Rules from other scopes ({contextRules.length})</summary><ul>{contextRules.map((rule, index) => <li key={index}>{labels[rule.kind]} · <code>{rule.pattern}</code>{rule.harnesses != null && ` · ${rule.harnesses.join(", ") || "no coding tools"}`}</li>)}</ul></details>}
		{row()}
		<p className="mcp-block-note">All tools keeps individual rules. Stronger individual decisions still apply. Codex and OpenCode cannot receive MCP rules through the current adapters.</p>
		<div className="mcp-permission-toolbar"><SearchInput inputProps={{ "aria-label": "Search MCP tools" }} placeholder="Search tools" value={query} onChange={setQuery} trailing={<span />} /><span className="mcp-block-note">{tools.length} stored tools</span></div>
		{visible.map((name) => row(name))}
		{query && visible.length === 0 && <p className="mcp-block-note">No matching tools.</p>}
		<div className="mcp-permission-manual"><Field label="Exact tool name"><input aria-label="Exact MCP tool name" placeholder="Exact tool name" disabled={disabled} value={manual} onChange={(event) => { setManual(event.target.value); setManualError(null); }} /></Field><Button size="sm" variant="ghost" disabled={!manual.trim() || disabled} onClick={() => {
			const value = manual.trim();
			if (!validMcpSegment(value)) { setManualError("Enter an exact tool name without wildcards or double underscores."); return; }
			setManualRows((rows) => rows.includes(value) ? rows : [...rows, value]);
			setQuery(""); setManual("");
		}}>Add tool</Button></div>
		{manualError && <span role="alert" className="mcp-block-note">{manualError}</span>}
		{changes.length > 0 && <div className="mcp-block-note" data-testid="mcp-permission-staged">Staged: {changes.map((change) => `${change.server} / ${change.tool ?? "all tools"} → ${labels[change.decision]}`).join(" · ")}</div>}
	</div>;
}
