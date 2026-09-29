import { useMemo, useState, type CSSProperties } from "react";
import { Button } from "@/components/Button";
import { LoadingButton, RowProgress } from "@/components/loading";
import { useProcessFor } from "@/store/processes";
import { BundleChip } from "@/components/BundleChip";
import { Chip } from "@/components/Chips";
import { Icon } from "@/components/Icon";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";
import { KindMark, ScopeBadge, Tag } from "@/components/Tag";
import { bundleColor } from "@/components/bundleColors";
import { useRegistry } from "@/hooks/useRegistry";
import { useListNav } from "@/hooks/useListNav";
import {
	inferSkillSourceId,
	isSourceEnabled,
	sourceAccent,
} from "@/lib/skillSource";
import {
	DROPPED_ACTION_ICON,
	DROPPED_ACTION_LABEL,
	droppedActionList,
	droppedHedge,
	type DroppedAction,
} from "@/lib/droppedSkillActions";
import type { DroppedSkill, SkillScope, SkillType, SourceType, SourceView } from "@/types";
import { fmtTimestamp, plural } from "@/screens/sources/sourceFormat";
import { SourceStatusLabel } from "@/screens/sources/SourceStatusLabel";
import { clickSink } from "@/lib/pressable";

/** Max skill chips shown before a card collapses behind a "+N more" toggle. */
const COLLAPSE_LIMIT = 8;

const SOURCE_TYPE_ICON: Record<SourceType, string> = {
	git: "source.git",
	starter: "source.starter",
	local: "source.local",
	litellm: "source.litellm",
};

const SOURCE_DESC: Record<string, string> = {
	local: "Skills you authored or imported as local copies.",
	starter: "Bundled starter pack shipped with Skill Hub.",
};

/** Copy shown on a disabled card — the whole point is that nothing was lost. */
const DISABLED_NOTE =
	"Skills stay registered — not synced to projects while disabled.";

export interface OwnedSkill {
	name: string;
	scope: SkillScope;
	type: SkillType;
}

export interface SourceCardProps {
	source: SourceView;
	registry: ReturnType<typeof useRegistry>["data"];
	/** Roving-focus props from `useListNav` (absent for non-navigable lists). */
	navProps?: ReturnType<ReturnType<typeof useListNav>["itemProps"]>;
	detailOpen: boolean;
	onToggleDetail?: () => void;
	onCheck?: () => void;
	onSync?: () => void;
	onRemove?: () => void;
	onRename?: () => void;
	onToggleEnabled?: () => void;
	onCreateBundle?: () => void;
	onAddToBundle?: () => void;
	onSkillClick?: (name: string) => void;
	onBundleClick?: (name: string) => void;
	busy?: boolean;
	disabled?: boolean;
	/** Transient ring for a card the navigator's `?focus=<id>` deep-link just
	 *  scrolled to — the screen clears it after ~1.5s. */
	highlighted?: boolean;
	/** This source's `source_missing` skills — the "Dropped upstream" block. */
	dropped?: DroppedSkill[];
	onDroppedAction?: (action: DroppedAction, row: DroppedSkill) => void;
	/** The hedge line's plain "Open" link, for a below-confidence
	 *  `possible_successor` that IS already registered. */
	onOpenPossibleSuccessor?: (registeredAs: string) => void;
	onForgetAllDropped?: (rows: DroppedSkill[]) => void;
	/** True while ANY forget (single or batch) is in flight — disables every
	 *  row action in the block. */
	droppedBusy?: boolean;
	/** Names currently mid-"Keep as local" — that ROW shows a spinner, the
	 *  others in the block stay live. */
	keepingLocalNames?: Set<string>;
}

export function SourceCard({
	source,
	registry,
	navProps,
	detailOpen,
	onToggleDetail,
	onCheck,
	onSync,
	onRemove,
	onRename,
	onToggleEnabled,
	onCreateBundle,
	onAddToBundle,
	onSkillClick,
	onBundleClick,
	busy,
	disabled,
	highlighted,
	dropped,
	onDroppedAction,
	onOpenPossibleSuccessor,
	onForgetAllDropped,
	droppedBusy,
	keepingLocalNames,
}: SourceCardProps) {
	const accent = sourceAccent(source.id);
	const isExternal = source.type === "git";
	const updateAvail = source.status === "update-available";
	const upToDate = source.status === "up-to-date";
	const isError = source.status === "error";
	const enabled = isSourceEnabled(source);
	// Curated membership (`sources.<id>.include`). The list view may predate the
	// field, so fall back to the registry config — absent means "follow upstream".
	const include =
		source.include ??
		(registry?.sources?.[source.id] as { include?: string[] } | undefined)?.include;
	// The id is the stable handle; only worth a line when the display name has
	// been renamed away from it.
	const showId = source.name !== source.id;

	const [expanded, setExpanded] = useState(false);

	const proc = useProcessFor(source.id);
	const isRunning = proc?.status === "running";

	const ownedSkills = useMemo<OwnedSkill[]>(() => {
		if (!registry) return [];
		const out: OwnedSkill[] = [];
		for (const [name, skill] of Object.entries(registry.skills ?? {})) {
			if (inferSkillSourceId(skill) === source.id) {
				out.push({ name, scope: skill.scope, type: skill.type });
			}
		}
		return out;
	}, [registry, source.id]);

	/** Bundles that carry at least one of this source's skills — "bundles in
	 *  sight", so the card answers "where do these skills actually go?". */
	const bundleNames = useMemo(() => {
		const owned = new Set(ownedSkills.map((s) => s.name));
		return Object.entries(registry?.bundles ?? {})
			.filter(
				([, b]) =>
					// A bundle that FOLLOWS this source belongs here even while it is
					// still empty — the link is the relationship, not the overlap.
					b.source === source.id ||
					(b.skills ?? []).some((s) => owned.has(s)),
			)
			.map(([name]) => name);
	}, [registry, ownedSkills, source.id]);

	const overflow = ownedSkills.length - COLLAPSE_LIMIT;
	const shownSkills = expanded ? ownedSkills : ownedSkills.slice(0, COLLAPSE_LIMIT);

	const menuItems: OverflowMenuItem[] = [];
	if (onRename && !source.builtin) {
		menuItems.push({ icon: "edit", label: "Rename…", onClick: onRename });
	}
	if (onCreateBundle && ownedSkills.length > 0) {
		menuItems.push({
			icon: "bundle",
			label: "Create bundle from source…",
			onClick: onCreateBundle,
		});
	}
	if (onAddToBundle && ownedSkills.length > 0) {
		menuItems.push({
			icon: "plus",
			label: "Add skills to bundle…",
			onClick: onAddToBundle,
		});
	}
	if (onToggleEnabled && !source.builtin) {
		menuItems.push({ divider: true });
		menuItems.push({
			icon: "power",
			label: enabled ? "Disable source" : "Enable source",
			onClick: onToggleEnabled,
			disabled: busy,
		});
	}
	if (onRemove && isExternal) {
		menuItems.push({
			icon: "trash",
			label: "Remove source…",
			danger: true,
			onClick: onRemove,
			disabled: busy,
		});
	}

	const skillsBlock = (isExternal || ownedSkills.length > 0) && (
		<div className="source-imported">
			<div className="source-imported-label">
				{isExternal ? "Imported skills" : "Skills"}
			</div>
			<div className="source-imported-list">
				{ownedSkills.length === 0 && (
					<span className="text-dim text-mono">No skills imported yet.</span>
				)}
				{shownSkills.map((sk) => (
					<Chip
						key={sk.name}
						title={sk.name}
						onClick={() => onSkillClick?.(sk.name)}
					>
						<ScopeBadge scope={sk.scope} />
						<span className="name">{sk.name}</span>
						<KindMark kind={sk.type} />
					</Chip>
				))}
				{overflow > 0 && (
					<button
						type="button"
						className="source-imported-toggle"
						aria-expanded={expanded}
						onClick={(e) => {
							e.stopPropagation();
							setExpanded((v) => !v);
						}}
					>
						{expanded ? "Show less" : `+${overflow} more`}
						<Icon name={expanded ? "chevronUp" : "chevronDown"} size={11} />
					</button>
				)}
			</div>
		</div>
	);

	const bundlesBlock = bundleNames.length > 0 && (
		<div className="source-imported" data-testid={`source-bundles-${source.id}`}>
			<div className="source-imported-label">In bundles</div>
			<div className="source-imported-list">
				{bundleNames.map((bn) => {
					// A bundle that FOLLOWS this source is marked — its membership
					// moves on every sync, unlike a one-off snapshot bundle. REVIEW-B
					// #4: a rendered `link` glyph (BundleChip's `trailing` slot), not
					// just a tooltip — visible at rest, keyboard/touch reachable.
					const follows = registry?.bundles?.[bn]?.source === source.id;
					return (
						<BundleChip
							key={bn}
							name={bn}
							icon={registry?.bundles?.[bn]?.icon ?? "📦"}
							color={bundleColor(bn)}
							onClick={() => onBundleClick?.(bn)}
							title={follows ? undefined : `Open bundle ${bn}`}
							trailing={
								follows ? (
									<Icon
										name="link"
										size={10}
										title={`${bn} follows this source`}
									/>
								) : undefined
							}
						/>
					);
				})}
			</div>
		</div>
	);

	/** Batch resolution for this source's dropped-upstream skills (spec
	 *  decision 2: no new screen — this card is where it lives). Each row
	 *  offers the same action set `droppedActionList` computes for the editor,
	 *  in the same order, so the two surfaces never disagree. */
	const droppedBlock = (dropped?.length ?? 0) > 0 && (
		<div className="source-imported" data-testid={`source-dropped-${source.id}`}>
			<div
				className="source-imported-label"
				style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
			>
				<span>Dropped upstream · {dropped!.length}</span>
				<Button
					variant="ghost"
					size="sm"
					icon="archive"
					disabled={droppedBusy}
					onClick={(e) => {
						e.stopPropagation();
						onForgetAllDropped?.(dropped!);
					}}
				>
					Forget all {dropped!.length}
				</Button>
			</div>
			<div className="source-dropped-list">
				{dropped!.map((row) => {
					const hedge = droppedHedge(row);
					return (
						<div className="source-dropped-item" key={row.name}>
							<div className="source-dropped-row">
								<span className="name text-mono">{row.name}</span>
								<span className="text-dim">
									{row.reason === "renamed" && row.successor
										? `renamed → ${row.successor.name}`
										: "deleted"}
								</span>
								<span className="text-dim">{fmtTimestamp(row.last_seen_at)}</span>
								<span className="source-dropped-actions" {...clickSink()}>
									{droppedActionList(row).map((a) =>
										a === "keep-local" ? (
											<LoadingButton
												key={a}
												variant="ghost"
												size="sm"
												icon={DROPPED_ACTION_ICON[a]}
												loading={keepingLocalNames?.has(row.name)}
												disabled={droppedBusy}
												onClick={() => onDroppedAction?.(a, row)}
											>
												{DROPPED_ACTION_LABEL[a]}
											</LoadingButton>
										) : (
											<Button
												key={a}
												variant="ghost"
												size="sm"
												icon={DROPPED_ACTION_ICON[a]}
												disabled={droppedBusy || keepingLocalNames?.has(row.name)}
												onClick={() => onDroppedAction?.(a, row)}
											>
												{DROPPED_ACTION_LABEL[a]}
											</Button>
										),
									)}
								</span>
							</div>
							{hedge && (
								<div className="source-dropped-hedge">
									<span>{hedge.text}</span>
									{hedge.registeredAs && (
										<Button
											variant="ghost"
											size="sm"
											disabled={droppedBusy}
											onClick={() => onOpenPossibleSuccessor?.(hedge.registeredAs!)}
										>
											Open
										</Button>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);

	return (
		<div
			{...navProps}
			className="source-card"
			data-source={source.id}
			data-status={source.status}
			data-disabled={disabled || undefined}
			data-off={!enabled ? "true" : undefined}
			data-running={isRunning ? "true" : undefined}
			data-nav-focus={highlighted || undefined}
			style={{ "--src-accent": accent, "--lds-accent": accent } as CSSProperties}
		>
			<div className="source-card-head">
				<div className="source-glyph">
					<Icon name={SOURCE_TYPE_ICON[source.type]} size={18} />
				</div>

				<div className="source-card-id">
					<div className="source-card-name">
						{source.name}
						{source.builtin && <Tag color="var(--fg-mute)">BUILT-IN</Tag>}
						{source.type === "litellm" && <Tag color="var(--anchor)">COMING SOON</Tag>}
						{!enabled && <Tag color="var(--fg-mute)">Disabled</Tag>}
						{/* A curated source doesn't follow upstream fully — say so, or a
						    later "why didn't that new skill show up?" has no answer. */}
						{include && include.length > 0 && (
							<Tag color="var(--fg-mute)">
								<span
									data-testid={`source-filtered-${source.id}`}
									title={`Only these upstream skills are imported: ${include.join(", ")}`}
								>
									Filtered · {include.length}
								</span>
							</Tag>
						)}
						{enabled && updateAvail && <Tag color="var(--blue)">Update available</Tag>}
						{enabled && upToDate && <Tag color="var(--green)">Up to date</Tag>}
						{isError && <Tag color="var(--red)">ERROR</Tag>}
					</div>
					<div className="source-card-meta">
						{showId && (
							<>
								<span className="text-mono text-dim">{source.id}</span>
								{isExternal && <span className="sep">·</span>}
							</>
						)}
						{isExternal ? (
							<>
								<span
										className="src-url text-mono text-dim"
										title={source.url ?? undefined}
									>
										{source.url ?? "—"}
									</span>
								{source.branch && (
									<>
										<span className="sep">·</span>
										<span className="text-mono">{source.branch}</span>
									</>
								)}
								{source.path && (
									<>
										<span className="sep">·</span>
										<span className="text-mono text-dim">/{source.path}</span>
									</>
								)}
							</>
						) : (
							<span className="text-mute">{SOURCE_DESC[source.id] ?? ""}</span>
						)}
					</div>
				</div>

				<div className="source-card-stat">
					<div className="value">{source.skill_count ?? ownedSkills.length}</div>
					<div className="label">skills</div>
				</div>

				{(dropped?.length ?? 0) > 0 && (
					<div
						className="source-card-stat source-card-stat-dropped"
						data-testid={`source-dropped-count-${source.id}`}
					>
						<div className="value" style={{ color: "var(--red)" }}>
							{dropped!.length}
						</div>
						<div className="label">dropped</div>
					</div>
				)}

				{!disabled && (
					<div className="source-card-actions" {...clickSink()}>
						{isExternal && (
							<>
								<Button
									variant="ghost"
									size="sm"
									icon="refresh"
									onClick={onCheck}
									disabled={busy || isRunning}
								>
									Check
								</Button>
								<LoadingButton
									variant={updateAvail ? "primary" : "ghost"}
									size="sm"
									icon={updateAvail ? "bolt" : "refresh"}
									onClick={onSync}
									disabled={busy}
									loading={isRunning}
									loadingLabel={
										proc && !proc.indeterminate
											? `Syncing… ${Math.round((proc.progress ?? 0) * 100)}%`
											: "Syncing…"
									}
								>
									{updateAvail ? "Sync update" : "Sync"}
								</LoadingButton>
							</>
						)}
						{menuItems.length > 0 && (
							<OverflowMenu
								items={menuItems}
								label={`Actions for ${source.name}`}
							/>
						)}
						{onToggleDetail && (
							<Button
								variant="ghost"
								size="sm"
								icon={detailOpen ? "chevronUp" : "chevronDown"}
								onClick={onToggleDetail}
								title={detailOpen ? "Collapse details" : "Expand details"}
							/>
						)}
					</div>
				)}
			</div>

			{isRunning && (
				<RowProgress
					value={proc.indeterminate ? null : proc.progress}
					accent={accent}
				/>
			)}

			{detailOpen && isExternal && !disabled && (
				<div className="source-card-detail">
					<div className="source-detail-row">
						<span className="k">current</span>
						<span className="v text-mono">
							{source.current_ref ? source.current_ref.slice(0, 7) : "—"}
						</span>
						{updateAvail && (
							<>
								<Icon name="arrowRight" size={11} style={{ color: "var(--blue)" }} />
								<span className="v text-mono" style={{ color: "var(--blue)" }}>
									{source.remote_ref ? source.remote_ref.slice(0, 7) : "—"}
								</span>
							</>
						)}
						<span className="dot-sep" />
						<SourceStatusLabel status={source.status} />
						{source.last_checked_at && (
							<>
								<span className="dot-sep" />
								<span className="k">checked {fmtTimestamp(source.last_checked_at)}</span>
							</>
						)}
						{source.last_synced_at && (
							<>
								<span className="dot-sep" />
								<span className="k">synced {fmtTimestamp(source.last_synced_at)}</span>
							</>
						)}
					</div>

					{!enabled && <p className="source-off-note">{DISABLED_NOTE}</p>}

					{include && include.length > 0 && (
						<p className="source-off-note" data-testid={`source-include-${source.id}`}>
							Curated: only {plural(include.length, "upstream skill")} are imported
							from this source. Syncs never add the rest.
						</p>
					)}

					{isError && source.error && (
						<div className="source-error">
							<Icon name="warning" size={12} />
							<span>{source.error}</span>
							<Button variant="ghost" size="sm">
								Configure auth
							</Button>
						</div>
					)}

					{skillsBlock}
					{bundlesBlock}
					{droppedBlock}
				</div>
			)}

			{detailOpen && !isExternal && !disabled && (
				<div className="source-card-detail">
					<div className="source-detail-row">
						<SourceStatusLabel status={source.status} />
						<span className="dot-sep" />
						<span className="k">{ownedSkills.length} skills owned</span>
						<span className="dot-sep" />
						<span className="k text-mono">~/.skill-hub/skills</span>
					</div>
					{!enabled && <p className="source-off-note">{DISABLED_NOTE}</p>}
					{skillsBlock}
					{bundlesBlock}
					{droppedBlock}
				</div>
			)}
		</div>
	);
}
