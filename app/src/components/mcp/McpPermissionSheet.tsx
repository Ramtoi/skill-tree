import { useEffect, useState } from "react";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { useMcpCatalog } from "@/hooks/useMcpCatalog";
import { usePermissionCapabilities, usePermissions } from "@/hooks/usePermissions";
import { McpPermissionControls } from "./McpPermissionControls";
import type { McpPermissionChange } from "@/lib/mcpPermissionRules";
import type { McpCatalog } from "@/lib/mcpContract";
import type { NormalizedPermissions, Scope } from "@/types/permissions";

export interface McpPermissionSheetProps {
	open: boolean;
	server: string;
	servers?: string[];
	scope: Scope;
	personalActive?: boolean;
	draft: NormalizedPermissions;
	onClose: () => void;
	onCancel?: () => void;
	onApply: (changes: McpPermissionChange[]) => Promise<boolean>;
	/** Usage presets save directly; the Permissions editor keeps staged copy. */
	mode?: "stage" | "save";
	/** Optional parent read gate (for example a fresh Global permissions read). */
	readiness?: { loading?: boolean; error?: string | null; blocked?: string | null; onRetry?: () => void };
	error?: string | null;
}

export function McpPermissionSheet({ open, server, servers = [server], scope, personalActive = false, draft, onClose, onCancel = onClose, onApply, mode = "stage", readiness, error }: McpPermissionSheetProps) {
	const [activeServer, setActiveServer] = useState(server);
	const [changes, setChanges] = useState<McpPermissionChange[]>([]);
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);
	const query = useMcpCatalog(activeServer, open);
	const capabilities = usePermissionCapabilities();
	const globalContext = usePermissions({ kind: "global" }, open && scope.kind === "project");
	const sharedContext = usePermissions(scope, open && scope.kind === "project" && personalActive === true, false);
	const personalContext = usePermissions(scope, open && scope.kind === "project" && personalActive === false, true);
	const contextQueries = scope.kind === "project" ? [globalContext, personalActive ? sharedContext : personalContext] : [];
	const contextLoading = contextQueries.some((item) => item.isLoading) || capabilities.isLoading;
	const contextError = contextQueries.find((item) => item.isError) ?? (capabilities.isError ? capabilities : null);
	const otherScopes = contextQueries.map((item) => item.data).filter((item): item is NormalizedPermissions => Boolean(item));

	useEffect(() => {
		if (!open) return;
		setActiveServer(server);
		setChanges([]);
		setApplyError(null);
	}, [open, server]);
	const catalog: McpCatalog | null = query.data?.ok ? query.data.catalog : null;
	const choose = (change: McpPermissionChange) => setChanges((current) => [
		...current.filter((item) => !(item.server === change.server && (item.tool ?? null) === (change.tool ?? null))),
		change,
	]);
	const submit = async () => {
		if (!changes.length || applying || readiness?.loading || readiness?.error || readiness?.blocked) return;
		setApplying(true);
		setApplyError(null);
		try {
			if (await onApply(changes)) onClose();
			else setApplyError("These MCP permissions were not applied. Your selections are still staged here.");
		} catch (error) {
			setApplyError(String(error));
		} finally {
			setApplying(false);
		}
	};

	return (
		<Modal open={open} dismissable={!applying} onClose={applying ? () => {} : onCancel} side="right" width={620} title="Add MCP permissions" footer={<>
			<Button variant="ghost" disabled={applying} onClick={onCancel}>Cancel</Button>
			<Button variant="primary" disabled={!changes.length || applying || contextLoading || Boolean(contextError) || Boolean(readiness?.loading || readiness?.error || readiness?.blocked)} onClick={() => void submit()}>{applying ? (mode === "save" ? "Saving…" : "Adding…") : mode === "save" ? "Save permissions" : "Add permissions"}</Button>
		</>}>
			<div className="mcp-permission-sheet-scope"><strong>{scope.kind === "global" ? "Global" : `Project ${scope.name} · ${personalActive ? "Personal" : "Shared"}`}</strong><span className="mcp-block-note">Only this active scope will be changed.</span></div>
			{readiness?.loading && <div role="status">Reading current Global permissions…</div>}
			{readiness?.error && <div className="mcp-block-note" role="alert">{readiness.error} {readiness.onRetry && <button type="button" onClick={readiness.onRetry}>Retry</button>}</div>}
			{readiness?.blocked && <div className="mcp-block-note" role="alert">{readiness.blocked} <a href="#/permissions">Open Global Permissions</a></div>}
			{servers.length > 1 && <Field label="MCP server"><select aria-label="MCP server" value={activeServer} disabled={applying} onChange={(event) => { setActiveServer(event.target.value); setApplyError(null); }}>{servers.map((item) => <option key={item}>{item}</option>)}</select></Field>}
			<p className="mcp-block-note">Choose decisions for {activeServer}. {mode === "save" ? "Changes are saved to Global permissions when you save." : "Changes stay local until you add them to the Permissions draft."}</p>
			{(error ?? applyError) && <div className="mcp-block-note" role="alert">{error ?? applyError}</div>}
			{contextLoading && <div role="status">Reading other permission scopes…</div>}
			{contextError && <div className="mcp-block-note" role="alert">A required permission scope failed to load. <button type="button" onClick={() => { for (const item of contextQueries) void item.refetch(); void capabilities.refetch(); }}>Retry</button></div>}
			{query.isLoading && <div role="status">Reading stored tool catalogue…</div>}
			{query.isError && <div className="mcp-block-note" role="alert">Stored tool catalogue failed to load. <button type="button" onClick={() => void query.refetch()}>Retry</button></div>}
			{!catalog && !query.isLoading && !query.isError && <div className="mcp-block-note">No stored tool catalogue. Add an exact tool name below.</div>}
			{!readiness?.loading && !readiness?.error && !readiness?.blocked && <McpPermissionControls server={activeServer} tools={catalog?.tools ?? []} draft={draft} changes={changes} onChange={choose} otherScopes={otherScopes} capabilities={capabilities.data ?? {}} scopeKind={scope.kind} disabled={applying || contextLoading || Boolean(contextError)} />}
		</Modal>
	);
}
