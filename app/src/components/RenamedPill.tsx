import { StatePill } from "@/components/StatePill";

/** The header's state while a rename is staged and not yet written — a bare
 *  `StatePill`. Generic (no skill-specific validation), so any editor that
 *  stages a rename through its header's `InlineName` can reuse it. */
export function RenamedPill() {
	return (
		<span title="Renamed here; ⌘S writes it">
			<StatePill state="unsaved" icon="edit">
				RENAMED
			</StatePill>
		</span>
	);
}
