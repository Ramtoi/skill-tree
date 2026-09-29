import { Button } from "@/components/Button";

interface EditorBarVerbsProps {
	/** Source-managed skill: the body is not editable here, so "Duplicate as
	 *  local" is offered as a soft verb beside Export — the two "take this
	 *  content elsewhere" actions sit together. Never the header's primary. */
	readOnly: boolean;
	/** Dropped upstream: the header carries its own verb set; no Duplicate. */
	dropped: boolean;
	exporting: boolean;
	onDuplicate: () => void;
	onExport: () => void;
}

/** The skill editor bar's document verbs (`DocumentEditorShell.headerActions`). */
export function EditorBarVerbs({
	readOnly,
	dropped,
	exporting,
	onDuplicate,
	onExport,
}: EditorBarVerbsProps) {
	return (
		<>
			{readOnly && !dropped && (
				<Button variant="soft" icon="copy" onClick={onDuplicate}>
					Duplicate as local
				</Button>
			)}
			<Button
				variant="soft"
				icon="export"
				busy={exporting}
				title="Export as a .skillpack file"
				onClick={onExport}
			>
				Export
			</Button>
		</>
	);
}
