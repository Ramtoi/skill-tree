import { useState } from "react";
import { ConfirmDialog } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { StatusBadge, type BadgeChannel } from "@/components/StatusBadge";
import { PathText } from "@/components/PathText";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { plural } from "@/lib/plural";
import {
	groupByHarness,
	harnessSummary,
	verdictLabel,
	activationWords,
	type NeedsCompanions,
	type CompanionItem,
	type CompanionKind,
	type CompanionVerdict,
	type HarnessGroup,
} from "@/lib/companions";

export interface CompanionConsequenceDialogProps {
	open: boolean;
	payload: NeedsCompanions | null;
	busy?: boolean;
	onConfirm: () => void;
	onClose: () => void;
}

/** Stable display order — the two hook-capable harnesses first (same list
 *  `lib/hookReach.ts` / `HarnessReachPanel.tsx` already carry independently;
 *  a harness present in the payload but missing here is appended afterward by
 *  `groupByHarness`, never dropped). */
const HARNESS_ORDER = ["claude-code", "codex", "opencode", "pi"];

/** S2: a capability gap is neither provenance nor risk severity, so every
 *  verdict but the trust row's own reads neutral — never amber. */
function verdictChannel(v: CompanionVerdict): BadgeChannel {
	return v === "will_write" ? "ok" : "neutral";
}

const KIND_ICON: Record<CompanionKind, string> = {
	hook: "hook",
	agent: "agent",
	permission: "permissions",
	trust: "warning",
};

const KIND_NOUN: Record<CompanionKind, [string, string]> = {
	hook: ["hook", "hooks"],
	agent: ["agent", "agents"],
	permission: ["rule", "rules"],
	trust: ["trust grant", "trust grants"], // NEVER_FOLD — never actually rendered
};

/** "3 hooks not written — Codex skips project-attached hooks" (W7): one line
 *  per harness combining every non-`will_write`, non-pinned item for that
 *  harness — counted per kind, reasons de-duplicated and joined in words so a
 *  fold never hides WHY without saying so. */
function foldedSentence(items: CompanionItem[]): string {
	const byKind = new Map<CompanionKind, CompanionItem[]>();
	for (const item of items) {
		const list = byKind.get(item.kind) ?? [];
		list.push(item);
		byKind.set(item.kind, list);
	}
	const counts = [...byKind.entries()].map(([kind, list]) => {
		const [singular, pluralForm] = KIND_NOUN[kind];
		return `${list.length} ${plural(list.length, singular, pluralForm)}`;
	});
	const reasons = Array.from(
		new Set(items.map((i) => i.reason).filter((r): r is string => !!r)),
	);
	const reasonText = reasons.length > 0 ? reasons.join("; ") : verdictLabel(items[0].verdict);
	return `${counts.join(", ")} not written — ${reasonText}`;
}

function TrustRow({ item }: { item: CompanionItem }) {
	return (
		<div className="companion-trust-row">
			<Icon name="warning" size={13} tone="amber" />
			<span className="companion-trust-text">{item.reason ?? verdictLabel(item.verdict)}</span>
			<StatusBadge channel="warn" shape="pill">
				{verdictLabel(item.verdict)}
			</StatusBadge>
		</div>
	);
}

function CompanionItemRow({ item, skill }: { item: CompanionItem; skill: string }) {
	return (
		<li className="companion-item-row">
			<Icon name={KIND_ICON[item.kind]} size={12} tone="mute" className="companion-item-kind" />
			<span className="companion-item-name text-mono">{item.name}</span>
			{item.activation && (
				<span className="companion-item-activation text-dim">
					{activationWords(item.activation, skill)}
				</span>
			)}
			{item.target !== null ? (
				<PathText path={item.target} className="companion-item-target text-dim text-mono" />
			) : (
				// S-2: a project-less read (W-4) has no target to name — never hand
				// `null` to `PathText`, which expects a real path string.
				<span className="companion-item-target companion-item-target-empty text-dim">
					no file
				</span>
			)}
			{/* I5 widened `reason` to `| null`; a DOM `title` prop stays
			    `string | undefined` — coalesce here, not in the shared type. */}
			<StatusBadge
				channel={verdictChannel(item.verdict)}
				shape="pill"
				title={item.reason ?? undefined}
			>
				{verdictLabel(item.verdict)}
			</StatusBadge>
		</li>
	);
}

/**
 * One harness's block, in the exact DOM order A2/C7 require: the header
 * (chevron + harness label + closed-state summary) first, THEN the pinned
 * trust row (never folded, no disclosure of its own), THEN the folded-count
 * line, THEN — only while expanded — the write-item list. A literal
 * `<SidePanelSection>` can't produce this order: everything it accepts as
 * `children` renders AFTER its head but is hidden while collapsed, and the
 * trust row + folded line must stay visible collapsed (that's the whole
 * point of W7's default view). So this hand-rolls the same chevron-head
 * markup/classes `SidePanelSection` uses (session-only open state, no
 * `storageKey` — a fresh dialog always starts collapsed) with an extra slot
 * between the head and the collapsible body.
 */
function HarnessGroupBlock({ group, skill }: { group: HarnessGroup; skill: string }) {
	const [open, setOpen] = useState(false);
	return (
		<section
			className="companion-harness-group companion-harness-summary side-panel-section"
			data-open={open || undefined}
			data-section-id={`companion-${group.harness}`}
		>
			<div className="side-panel-section-head-row">
				<button
					type="button"
					className="side-panel-section-head"
					aria-expanded={open}
					data-testid={`side-section-companion-${group.harness}`}
					onClick={() => setOpen((v) => !v)}
				>
					<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
					<span className="side-panel-section-title">{harnessLabel(group.harness)}</span>
				</button>
				<span className="side-panel-section-summary companion-harness-summary-text">
					<HarnessGlyph id={group.harness} size={14} decorative />
					{harnessSummary(group)}
				</span>
			</div>
			{group.pinned.map((item) => (
				<TrustRow key={`${item.kind}-${item.name}-${item.harness}`} item={item} />
			))}
			{group.folded.length > 0 && (
				<p className="companion-folded-line text-dim">{foldedSentence(group.folded)}</p>
			)}
			{open && (
				<div className="side-panel-section-body">
					{group.write.length > 0 ? (
						<ul className="companion-item-list">
							{group.write.map((item) => (
								<CompanionItemRow
									key={`${item.kind}-${item.name}-${item.harness}`}
									item={item}
									skill={skill}
								/>
							))}
						</ul>
					) : (
						<p className="companion-item-list-empty text-dim">Nothing to write here.</p>
					)}
				</div>
			)}
		</section>
	);
}

/**
 * `ConfirmDialog` preset for the `ships_with` equip consequence (D2/D5, plan 2
 * §Approach "The dialog is a summary, not a list"). Default view is one
 * collapsed summary row per harness plus a folded count line for anything not
 * `will_write` — a `kind: "trust"` item is exempt (`NEVER_FOLD`): it renders
 * as its own full-sentence row, first inside its harness group, with no fold
 * control. Per I1 + A4 the registry equip has ALREADY landed at exit 2, so
 * `cancelLabel` reads "Equip skill only" (an acknowledgement, not a cancel) —
 * Esc and the backdrop mean the same thing.
 */
export function CompanionConsequenceDialog({
	open,
	payload,
	busy = false,
	onConfirm,
	onClose,
}: CompanionConsequenceDialogProps) {
	const groups = payload ? groupByHarness(payload.items, HARNESS_ORDER) : [];
	return (
		<ConfirmDialog
			open={open}
			onClose={onClose}
			onConfirm={onConfirm}
			title={
				payload
					? `${payload.skill} is equipped on ${payload.project}. It also ships:`
					: ""
			}
			confirmLabel="Equip with companions"
			cancelLabel="Equip skill only"
			confirmIcon="check"
			busy={busy}
			width={560}
			blastRadius={
				payload && (
					<div className="companion-consequence-body">
						{groups.map((g) => (
							<HarnessGroupBlock key={g.harness} group={g} skill={payload.skill} />
						))}
					</div>
				)
			}
		/>
	);
}
