import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { useMcpCatalog } from "@/hooks/useMcpCatalog";
import { getAdoptionRequired, usePermissionCapabilities, usePermissions } from "@/hooks/usePermissions";
import { usePermissionsDraft } from "@/hooks/usePermissionsDraft";
import { McpPermissionControls } from "./McpPermissionControls";
import type { Scope } from "@/types/permissions";
import type { McpPermissionChange } from "@/lib/mcpPermissionRules";

/** MCP permissions are edited from the MCP detail page at Global scope. */
export function McpPermissionsBlock({ name, sourceReadOnly = false }: { name: string; sourceReadOnly?: boolean }) {
	const scope: Scope = { kind: "global" };
	const catalog = useMcpCatalog(name, true);
	const permissions = usePermissions(scope, true);
	const capabilities = usePermissionCapabilities();
	const [changes, setChanges] = useState<McpPermissionChange[]>([]);
	const draft = usePermissionsDraft({ scope, personalActive: false, permsData: permissions.data, invalidatePerms: () => { void permissions.refetch(); }, onFilterKind: () => {}, onFilterAll: () => {}, onFocusTarget: () => {} });
	const payload = catalog.data?.ok ? catalog.data.catalog : null;
	const adoption = getAdoptionRequired(permissions.data);
	const loading = permissions.isLoading || capabilities.isLoading;
	const contextError = permissions.isError || capabilities.isError;
	const blocked = Boolean(adoption) || loading || contextError || !draft.draft;
	const tools = payload?.tools ?? [];
	const decisionChanges = useMemo(() => changes.filter((change) => change.server === name), [changes, name]);
	const choose = (change: McpPermissionChange) => setChanges((current) => [
		...current.filter((item) => !(item.server === change.server && (item.tool ?? null) === (change.tool ?? null))), change,
	]);
	const save = async () => {
		if (!changes.length || !draft.draft) return;
		const next = await draft.applyMcpChanges(changes);
		if (!next) return;
		if (await draft.doSaveDraft(next)) setChanges([]);
	};
	return (
		<section className="mcp-block mcp-permissions-block" data-block="permissions" data-testid="mcp-permissions-block">
			<div className="mcp-permissions-heading"><div><SectionHeader label="PERMISSIONS" /><span className="mcp-block-note">Global · applies to all projects</span></div><div className="mcp-permissions-actions"><Button size="sm" variant="ghost" disabled={!changes.length || draft.saving || draft.applyingMcp} onClick={() => { setChanges([]); draft.doDiscard(); }}>Discard</Button><Button aria-label="Save permissions" size="sm" variant="primary" disabled={blocked || !changes.length || draft.saving || draft.applyingMcp} onClick={() => void save()}>Save permissions</Button></div></div>
			{loading && <div className="mcp-block-note" role="status">Reading Global permission context…</div>}
			{contextError && <div className="mcp-block-note" role="alert">Permission context failed to load. <button type="button" onClick={() => { void permissions.refetch(); void capabilities.refetch(); }}>Retry</button></div>}
			{adoption && <div className="mcp-block-note" role="alert">Resolve adoption before editing. <a href="#/permissions">Open Global Permissions</a></div>}
			{draft.saveError && <div className="mcp-block-note" role="alert">{draft.saveError}</div>}
			{draft.lastSyncRc === 1 && <div className="mcp-block-note" role="alert">Saved, but native permission files need Sync.</div>}
			{draft.lastSyncRc === 2 && <div className="mcp-block-note" role="alert">Saved, but Sync reported findings that need review.</div>}
			{!blocked && draft.draft && <McpPermissionControls server={name} tools={tools} draft={draft.draft} changes={decisionChanges} capabilities={capabilities.data ?? {}} scopeKind="global" otherScopes={[]} disabled={draft.saving || draft.applyingMcp} onChange={choose} />}
			{catalog.isLoading && <div className="mcp-block-note" role="status">Reading stored tool catalogue…</div>}
			{catalog.isError && <div className="mcp-block-note" role="alert">Stored tool catalogue failed to load. <button type="button" onClick={() => void catalog.refetch()}>Retry</button></div>}
			{!payload && !catalog.isLoading && !catalog.isError && <div className="mcp-block-note">No stored tool catalogue. Enter an exact tool name to configure it.</div>}
			{sourceReadOnly && <div className="mcp-block-note">Connection fields are read-only; these user permission rules remain editable.</div>}
		</section>
	);
}
