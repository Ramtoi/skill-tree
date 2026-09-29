import { AdoptionDialog } from "../AdoptionDialog";
import { ImportMergeDialog } from "../ImportMergeDialog";
import { DisableDialog } from "../DisableDialog";
import { PermissionsDoctorPanel } from "../PermissionsDoctorPanel";
import { ConfirmDialog } from "../Modal";
import { PresetsSheet } from "../PresetsSheet";
import { McpPermissionSheet } from "../mcp/McpPermissionSheet";
import type { McpPermissionChange } from "@/lib/mcpPermissionRules";
import type {
	AdoptionRequired,
	DisableResult,
	DoctorFinding,
	NormalizedPermissions,
	Rule,
	Scope,
} from "@/types/permissions";

/**
 * One discriminated-union slot for the seven mutually exclusive permissions
 * overlays (only one can be open at a time). `PermissionsEditor` owns the
 * single `overlay` useState; this component is a pure projection of it.
 */
export type PermissionsOverlay =
	| { kind: "none" }
	| { kind: "disable" }
	| { kind: "doctor" }
	| { kind: "presets" }
	| { kind: "import" }
	| { kind: "trust" }
	| { kind: "discard"; count: number }
	| { kind: "mcp"; server: string };

// MCP is deliberately part of the same exclusive slot: opening it closes
// every other permissions overlay and Escape returns to the parent draft.

export interface PermissionsOverlaysProps {
	overlay: PermissionsOverlay;
	onClose: () => void;
	scope: Scope;
	projectCount: number;
	harnessLabels: Record<string, string>;
	draft: NormalizedPermissions | null;
	personalActive?: boolean;
	saving: boolean;
	adoptionBlocking: boolean;
	adoptionRequired: AdoptionRequired;
	doctor: { findings: DoctorFinding[]; loading: boolean; error: string | null };
	onInvalidate: (scopes?: Scope[]) => void;
	onJumpToFinding: (f: DoctorFinding) => void;
	onApplyPresetRules: (rules: Rule[]) => void;
	onConfirmDiscard: () => void;
	onConfirmTrust: () => void;
	onApplyMcpChanges?: (changes: McpPermissionChange[]) => Promise<boolean>;
	mcpServers?: string[];
}

export function PermissionsOverlays({
	overlay,
	onClose,
	scope,
	projectCount,
	harnessLabels,
	draft,
	personalActive = false,
	saving,
	adoptionBlocking,
	adoptionRequired,
	doctor,
	onInvalidate,
	onJumpToFinding,
	onApplyPresetRules,
	onConfirmDiscard,
	onConfirmTrust,
	onApplyMcpChanges,
	mcpServers = [],
}: PermissionsOverlaysProps) {
	return (
		<>
			<AdoptionDialog
				open={adoptionBlocking}
				discovered={adoptionRequired}
				harnessLabels={harnessLabels}
				onResolved={() => onInvalidate()}
			/>
			<ImportMergeDialog
				open={overlay.kind === "import"}
				scope={scope}
				harnessLabels={harnessLabels}
				onClose={onClose}
				onApplied={() => onInvalidate()}
			/>
			<DisableDialog
				open={overlay.kind === "disable"}
				fromScope={scope}
				projectCount={projectCount}
				onClose={onClose}
				onApplied={(result: DisableResult) => {
					const touched = (result.scopes_touched ?? []).map<Scope>((s) =>
						s.kind === "global"
							? { kind: "global" }
							: { kind: "project", name: s.name ?? "" },
					);
					onInvalidate(touched);
				}}
			/>
			<PermissionsDoctorPanel
				open={overlay.kind === "doctor"}
				findings={doctor.findings}
				loading={doctor.loading}
				error={doctor.error}
				onClose={onClose}
				onJumpToFinding={onJumpToFinding}
			/>
			{draft && (
				<PresetsSheet
					open={overlay.kind === "presets"}
					scope={scope}
					currentRules={draft.allow}
					onApplyRules={onApplyPresetRules}
					onClose={onClose}
				/>
			)}
			{draft && overlay.kind === "mcp" && onApplyMcpChanges && (
				<McpPermissionSheet open server={overlay.server} servers={mcpServers} scope={scope} personalActive={personalActive} draft={draft} onClose={onClose} onApply={onApplyMcpChanges} />
			)}
			<ConfirmDialog
				open={overlay.kind === "discard"}
				title="Discard staged changes?"
				tone="danger"
				confirmLabel="Discard changes"
				confirmIcon="trash"
				onClose={onClose}
				onConfirm={onConfirmDiscard}
				body={
					<p>
						This drops{" "}
						<strong>{overlay.kind === "discard" ? overlay.count : 0}</strong>{" "}
						staged edit
						{(overlay.kind === "discard" ? overlay.count : 0) === 1 ? "" : "s"}{" "}
						and reverts to the last saved rules. This cannot be undone.
					</p>
				}
			/>
			<ConfirmDialog
				open={overlay.kind === "trust"}
				title="Grant Codex trust to this project?"
				confirmLabel="Save & grant trust"
				confirmIcon="save"
				busy={saving}
				onClose={onClose}
				onConfirm={onConfirmTrust}
				body={
					<p>
						Saving a Codex command rule auto-grants{" "}
						<code>trust_level="trusted"</code> to this project — which also
						activates any committed <code>.codex/config.toml</code> and
						project-local hooks. Only grant trust for a repository you trust.
					</p>
				}
			/>
		</>
	);
}
