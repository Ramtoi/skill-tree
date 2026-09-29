import type { DroppedSkill } from "@/types";
import { Button } from "./Button";
import { LoadingButton } from "@/components/loading";
import { Plaque } from "./Plaque";
import {
	DROPPED_ACTION_ICON,
	DROPPED_ACTION_LABEL,
	droppedHedge,
	droppedOverflowActions,
	droppedPrimaryAction,
	droppedReasonText,
	type DroppedAction,
} from "@/lib/droppedSkillActions";
import { removalLoadingLabel } from "@/hooks/useSkillRemoval";
import { fmtTimestamp } from "@/screens/sources/sourceFormat";

export interface DroppedUpstreamBannerProps {
	dropped: DroppedSkill;
	onAction: (action: DroppedAction) => void;
	/** The hedge's plain "Open" link — never wired through `onAction`, since a
	 *  below-confidence guess is not a confirmed rename (never a primary,
	 *  never part of the action set). Omitted (or a null `registeredAs`)
	 *  simply renders no link. */
	onOpenPossibleSuccessor?: (registeredAs: string) => void;
	busy: boolean;
}

/**
 * Side panel banner for a skill upstream dropped (`source_missing`) —
 * replaces `ExternalSourceBanner` for these. Same `Plaque` (`.source-banner`
 * in `styles/side-panel.css`) but error-toned: this is a status, never a
 * provenance note.
 * The primary action is computed by the SAME pure helper the editor header
 * uses, so the two can never disagree about which button is primary.
 */
export function DroppedUpstreamBanner({
	dropped,
	onAction,
	onOpenPossibleSuccessor,
	busy,
}: DroppedUpstreamBannerProps) {
	const primary = droppedPrimaryAction(dropped);
	const overflow = droppedOverflowActions(dropped);
	const hedge = droppedHedge(dropped);

	return (
		<Plaque
			className="dropped-upstream-banner"
			data-testid="dropped-upstream-banner"
			data-reason={dropped.reason}
			eyebrow={
				<>
					Dropped upstream · <span className="text-mono">{dropped.source_name}</span>
				</>
			}
			accent="red"
			actions={
				<>
					<LoadingButton
						variant="primary"
						size="sm"
						icon={DROPPED_ACTION_ICON[primary]}
						loading={busy}
						loadingLabel={
							primary === "forget" ? removalLoadingLabel("forget") : undefined
						}
						disabled={busy}
						onClick={() => onAction(primary)}
					>
						{DROPPED_ACTION_LABEL[primary]}
					</LoadingButton>
					{overflow.map((a) => (
						<Button
							key={a}
							variant="ghost"
							size="sm"
							icon={DROPPED_ACTION_ICON[a]}
							disabled={busy}
							onClick={() => onAction(a)}
						>
							{DROPPED_ACTION_LABEL[a]}
						</Button>
					))}
				</>
			}
		>
			<div className="source-banner-meta">
				Last seen {fmtTimestamp(dropped.last_seen_at)} at {dropped.ref_short ?? "—"}
			</div>
			<p className="source-banner-copy">{droppedReasonText(dropped)}</p>
			{hedge && (
				<div className="source-banner-hedge">
					<span>{hedge.text}</span>
					{hedge.registeredAs && (
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => onOpenPossibleSuccessor?.(hedge.registeredAs!)}
						>
							Open
						</Button>
					)}
				</div>
			)}
		</Plaque>
	);
}
