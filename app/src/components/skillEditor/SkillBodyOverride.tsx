import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { fmtSize } from "@/components/agentDocs/agentDocHelpers";
import { fmtTimestamp } from "@/screens/sources/sourceFormat";
import type { SkillFileEntry } from "@/lib/skillFiles";
import type { DroppedSkill } from "@/types";

export interface SkillBodyOverrideProps {
	/** `skill.source_missing` — takes priority over every file-editing state
	 *  below (a dropped skill's checkout has no files to fall back on). */
	dropped: boolean;
	droppedPending: boolean;
	droppedData: DroppedSkill | null;
	isSkillMd: boolean;
	activeRel: string;
	activeEntry: SkillFileEntry | undefined;
	activeUnopenable: boolean;
	activeMissing: boolean;
	activeBuffer: unknown;
	skillRoot: string;
	onReveal: (rel?: string) => void;
	onRefetchFiles: () => void;
}

/**
 * What replaces the editor body instead of CodeMirror, or `null` for the
 * normal case. Never returns a blank editor: a dropped skill either shows its
 * pinned-ref content (no override) or one of these two explanations; a
 * multi-file skill's binary/missing/still-opening rows get their own.
 */
/** Pure — call it directly as a function (`resolveSkillBodyOverride({...})`),
 *  never as JSX. It has no hooks, and the caller needs the real `null` back
 *  (a `<Foo/>` element is truthy even when `Foo` renders nothing), since the
 *  footer's line/char count is gated on `!bodyOverride`. */
export function resolveSkillBodyOverride({
	dropped,
	droppedPending,
	droppedData,
	isSkillMd,
	activeRel,
	activeEntry,
	activeUnopenable,
	activeMissing,
	activeBuffer,
	skillRoot,
	onReveal,
	onRefetchFiles,
}: SkillBodyOverrideProps): ReactNode {
	if (dropped) {
		if (droppedPending) {
			return (
				<EmptyState
					icon="search"
					title="Reading dropped content"
					description="Checking the source checkout for the pinned commit…"
				/>
			);
		}
		if (!droppedData?.skill_md) {
			return (
				<EmptyState
					icon="warning"
					title="Content is no longer in the checkout"
					description={`Dropped at ${droppedData?.ref_short ?? "—"} · ${fmtTimestamp(droppedData?.last_seen_at)}`}
				/>
			);
		}
		// Otherwise: no override — the pinned ref's SKILL.md renders read-only
		// in the editor body, loaded by the caller's own effect.
		return null;
	}
	if (activeUnopenable) {
		return (
			<EmptyState
				icon="doc"
				title={<span className="text-mono">{activeRel}</span>}
				description={`${
					activeEntry?.reason === "too_large" ? "Too large to edit" : "Binary file"
				} · ${fmtSize(activeEntry?.size)} · Skill Tree edits text only`}
				action={
					<Button icon="folder" disabled={!skillRoot} onClick={() => onReveal(activeRel)}>
						Reveal in Finder
					</Button>
				}
			/>
		);
	}
	if (!isSkillMd && activeMissing) {
		return (
			<EmptyState
				icon="warning"
				title="File not found on disk"
				description={activeRel}
				action={
					<Button icon="refresh" onClick={onRefetchFiles}>
						Refresh
					</Button>
				}
			/>
		);
	}
	if (!isSkillMd && !activeBuffer) {
		return <EmptyState icon="search" title="Opening file" description={activeRel} />;
	}
	return null;
}
