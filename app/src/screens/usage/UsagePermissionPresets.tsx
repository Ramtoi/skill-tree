import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { McpPermissionSheet } from "@/components/mcp/McpPermissionSheet";
import { Popover } from "@/components/Popover";
import { SectionHeader } from "@/components/SectionHeader";
import { usePermissions, getAdoptionRequired } from "@/hooks/usePermissions";
import { usePermissionsDraft } from "@/hooks/usePermissionsDraft";
import { useRegistry } from "@/hooks/useRegistry";
import { invalidateRegistry } from "@/lib/invalidate";
import { useAppStore } from "@/store";
import type { McpPermissionChange } from "@/lib/mcpPermissionRules";
import type { NormalizedPermissions } from "@/types/permissions";

const EMPTY_PERMISSIONS: NormalizedPermissions = {
	allow: [], deny: [], ask: [], hooks: [], sandbox_mode: null,
	approval_policy: null, project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [],
};

export function UsagePermissionPresets() {
	const addRef = useRef<HTMLButtonElement | null>(null);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [freshRead, setFreshRead] = useState(false);
	const [freshData, setFreshData] = useState<unknown>(null);
	const [draftReady, setDraftReady] = useState(false);
	const [readError, setReadError] = useState<string | null>(null);
	const saveStarted = useRef(false);
	const saveAttempted = useRef(false);
	const readRequest = useRef(0);
	const sheetOpenRef = useRef(sheetOpen);
	const registry = useRegistry();
	const permissions = usePermissions({ kind: "global" }, sheetOpen);
	const refetchPermissions = permissions.refetch;
	const permissionsDataRef = useRef(permissions.data);
	permissionsDataRef.current = permissions.data;
	sheetOpenRef.current = sheetOpen;
	const queryClient = useQueryClient();
	const addToast = useAppStore((state) => state.addToast);
	const draft = usePermissionsDraft({
		scope: { kind: "global" },
		personalActive: false,
		permsData: permissions.data,
		invalidatePerms: () => { void permissions.refetch(); },
		onFilterKind: () => {},
		onFilterAll: () => {},
		onFocusTarget: () => {},
	});
	const servers = useMemo(
		() => Object.entries(registry.data?.skills ?? {}).filter(([, skill]) => skill.type === "mcp-server").map(([name]) => name).sort(),
		[registry.data],
	);
	const server = servers[0] ?? "";
	const adoption = getAdoptionRequired(permissions.data);
	const registryError = registry.isError ? "The MCP registry could not be read. Retry the registry read before choosing a preset." : null;
	const registryLoading = registry.isLoading;

	const readCurrentPermissions = useCallback(async () => {
		const request = ++readRequest.current;
		setFreshRead(false);
		setFreshData(null);
		setDraftReady(false);
		setReadError(null);
		try {
			const result = await refetchPermissions();
			if (request !== readRequest.current || !sheetOpenRef.current) return;
			if (result.error) {
				setReadError(String(result.error));
				return;
			}
			setFreshData(result.data ?? permissionsDataRef.current);
			setFreshRead(true);
		} catch (error) {
			if (request === readRequest.current && sheetOpenRef.current) setReadError(String(error));
		}
	}, [refetchPermissions]);
	useEffect(() => {
		if (sheetOpen) void readCurrentPermissions();
		else ++readRequest.current;
	}, [sheetOpen, readCurrentPermissions]);
	useEffect(() => {
		if (freshRead && freshData !== null && permissions.data === freshData && draft.draft) setDraftReady(true);
	}, [draft.draft, freshData, freshRead, permissions.data]);
	useEffect(() => {
		if (sheetOpen || !saveStarted.current) return;
		saveStarted.current = false;
		if (draft.lastSyncRc === 1) addToast("info", "Saved, but some native permission files need Sync.");
		if (draft.lastSyncRc === 2) addToast("info", "Saved, but Sync reported findings that need review.");
	}, [addToast, sheetOpen, draft.lastSyncRc]);

	const closeSheet = () => {
		if (draft.applyingMcp || draft.saving) return;
		++readRequest.current;
		saveAttempted.current = false;
		setSheetOpen(false);
		draft.doDiscard();
		// eslint-disable-next-line no-restricted-syntax -- `addRef` is the always-mounted Add trigger, never a node whose mount depends on this same close; the rAF only sequences after the sheet's own unmount.
		requestAnimationFrame(() => addRef.current?.focus({ preventScroll: true }));
	};
	const finishSheet = () => {
		++readRequest.current;
		saveAttempted.current = false;
		setSheetOpen(false);
		// eslint-disable-next-line no-restricted-syntax -- same always-mounted Add trigger as `closeSheet` above.
		requestAnimationFrame(() => addRef.current?.focus({ preventScroll: true }));
	};
	const applyAndSave = async (changes: McpPermissionChange[]) => {
		saveAttempted.current = true;
		const next = await draft.applyMcpChanges(changes);
		if (!next) return false;
		const saved = await draft.doSaveDraft(next);
		if (saved) {
			saveStarted.current = true;
			void Promise.allSettled([
				invalidateRegistry(queryClient),
				registry.refetch(),
				permissions.refetch(),
			]);
			return true;
		}
		return false;
	};

	return (
		<div className="usage-permission-presets">
			<span ref={(node) => { addRef.current = node?.querySelector<HTMLButtonElement>("button") ?? null; }} className="usage-add-anchor"><Button aria-label="Add" aria-haspopup="dialog" aria-expanded={popoverOpen} icon="plus" onClick={() => setPopoverOpen((open) => !open)}>Add</Button></span>
			<Popover open={popoverOpen} onClose={() => setPopoverOpen(false)} anchorRef={addRef} label="Add permission presets" width={280}>
				<div className="usage-permission-popover">
					<SectionHeader label="Permission presets" />
					{registryLoading && <div role="status">Reading registered MCP servers…</div>}
					{registryError && <div className="mcp-block-note" role="alert">{registryError} <button type="button" onClick={() => void registry.refetch()}>Retry</button></div>}
					{!registryLoading && !registryError && servers.length === 0 && <p className="mcp-block-note">No registered MCP servers. <a href="#/">Open Library</a> to add one first.</p>}
					{!registryLoading && !registryError && servers.length > 0 && <Button variant="soft" onClick={() => { setPopoverOpen(false); setSheetOpen(true); }}>MCP permissions</Button>}
				</div>
			</Popover>
			<McpPermissionSheet
				open={sheetOpen}
				server={server}
				servers={servers}
				scope={{ kind: "global" }}
				draft={draft.draft ?? EMPTY_PERMISSIONS}
				onClose={finishSheet}
				onCancel={closeSheet}
				onApply={applyAndSave}
				mode="save"
				readiness={{
					loading: !freshRead || permissions.isFetching || !draftReady,
					error: readError ?? registryError,
					blocked: adoption ? "Resolve permission adoption before editing Global permissions." : null,
					onRetry: registryError ? () => { void registry.refetch(); } : () => { void readCurrentPermissions(); },
				}}
				error={saveAttempted.current ? draft.saveError : null}
			/>
		</div>
	);
}
