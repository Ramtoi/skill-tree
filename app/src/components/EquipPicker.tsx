import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	isValidElement,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { ResourceRow } from "./ResourceRow";
import { Toggle } from "./Toggle";
import { SearchInput } from "./SearchInput";
import { Icon } from "./Icon";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { formatProspectiveSkillLine } from "@/lib/usageGuidance";
import { tokensOf } from "@/lib/footprintTokens";
import { useAppStore } from "@/store";
import { Spinner } from "./loading/Spinner";
import { clickSink } from "@/lib/pressable";

/** How long a settled row holds `synced` in its meta slot (COMPONENTS.md
 *  §In-flight and settled state). Bespoke — not on the `--dur-*` scale. */
const SETTLED_HOLD_MS = 2400;

export type EquipState = "on" | "off" | "via-bundle";

export interface EquipTarget {
	/** Stable key for react keys + optimistic tracking (e.g. project/bundle name). */
	id: string;
	/** Mono proper-noun identifier shown as the row title. */
	name: string;
	/** Identity glyph: ScopeBadge / harness glyph / bundle glyph / emoji. */
	glyph?: ReactNode;
	/** Current membership of the subject in this target. */
	state: EquipState;
	/** When state === "via-bundle": the providing bundle(s); read-only + linked. */
	providedBy?: { name: string; href: string }[];
	/** Secondary line (scope, project path, harness affinity). */
	meta?: ReactNode;
	/** Consequence of a toggle ("N projects lose this skill"). A visible line in
	 *  the popover; the row's `title` in the dense inline variant. */
	blastRadius?: string;
	/** Non-actionable with a reason (e.g. affinity mismatch). */
	disabledReason?: string;
}

interface SkillDocument {
	name: string;
	description: string;
}

/** One cached document read per rendered skill. Callers pass only effective
 * harness directories; an unavailable document never becomes a byte estimate. */
export function useProspectiveSkillCost(
	name: string,
	projectSkillsDirs?: readonly string[],
	enabled = true,
): string {
	const harnesses = useAppStore((state) => state.harnesses);
	const storeDirs = useMemo(() => harnesses
		.map((harness) => harness.project_skills_dir)
		.filter((dir): dir is string => Boolean(dir)), [harnesses]);
	const dirs = projectSkillsDirs ?? storeDirs;
	const query = useQuery({
		queryKey: qk.skillDocument(name),
		enabled: enabled && dirs.length > 0,
		queryFn: () => invoke<SkillDocument>("read_skill_document", { name }),
	});
	if (query.isPending) return "…";
	if (query.isError || !query.data || dirs.length === 0) return "token count unavailable";
	const values = dirs.map((dir) => tokensOf(formatProspectiveSkillLine({
		name: query.data.name,
		description: query.data.description,
		projectSkillsDir: dir,
	})));
	return `~${values[0]} tokens`;
}

export function ProspectiveCostCell({ name, projectSkillsDirs }: {
	name: string;
	projectSkillsDirs?: readonly string[];
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
	useEffect(() => {
		if (!ref.current || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
		observer.observe(ref.current);
		return () => observer.disconnect();
	}, []);
	const cost = useProspectiveSkillCost(name, projectSkillsDirs, visible);
	// `.avail-cost` is the class the Available row styles, the scenes and the
	// guidance journey select on; the picker row shares it.
	// Compact in the row (the long phrase pushed the skill name out of a narrow
	// row); the tooltip carries the unit.
	return <span ref={ref} className="avail-cost" title={cost.startsWith("~") ? `${cost} every session` : cost}>{cost}</span>;
}

export interface EquipPickerProps {
	subject: { kind: "skill" | "bundle" | "remote" | "cloud"; name: string };
	targets: EquipTarget[];
	/** Toggle one target. Returns a promise; the picker shows optimistic pending
	 *  until it settles and reverts the row on rejection. */
	onToggle: (target: EquipTarget, next: "on" | "off") => Promise<void>;
	loading?: boolean;
	searchPlaceholder?: string;
	emptyLabel?: ReactNode;
	footer?: ReactNode;
	/** "popover" = anchored, Esc/onClose closes; "inline" = always-open panel. */
	variant?: "popover" | "inline";
	/** Render the search box only past this many targets (the navigator's
	 *  filter rule). Default 0 = always; the popover keeps it for `autoFocus`. */
	filterThreshold?: number;
	/** Accessible name of the target list (default `<subject> targets`). Two
	 *  inline pickers in one section — USED BY's Projects and Bundles — need
	 *  names of their own. */
	listLabel?: string;
	/** Overrides the checkbox's accessible-name sentence (default:
	 *  `${Equip|Unequip} ${subject.name} ${target.name}`). Needed when the
	 *  subject reads more naturally as the sentence's OBJECT rather than its
	 *  verb's direct object — a bundle's skill membership reads as "Add
	 *  react-conventions to android", not "Equip android react-conventions". */
	toggleLabel?: (target: EquipTarget, state: EquipState) => string;
	/** Locks EVERY target at once for the SAME reason (e.g. a bundle that
	 *  follows a source: membership isn't the reader's to change, whatever the
	 *  target). Rendered ONCE as a dim line above the list — never repeated on
	 *  each row — and each row's `title` becomes this reason instead of its own
	 *  `blastRadius`. A target's own `disabledReason` is still for a genuinely
	 *  PER-ROW reason (e.g. one bundle among many is itself locked); the two
	 *  are independent and `lockedReason` takes precedence when both apply. */
	lockedReason?: string;
	/** The settled word held in the meta slot for ~2.4s after a toggle resolves
	 *  (COMPONENTS.md §In-flight and settled state). Default `"synced"` fits a
	 *  write that reached disk through hub's own sync; pass `"queued"` for a
	 *  registry-only write with no local sync (a remote/cloud equip, whose
	 *  success toast already says "Reconciled on next sync"), or `false` when
	 *  the toggle only stages a draft that a later Save writes — `false` drops
	 *  both the word and `data-settled`. */
	settledLabel?: string | false;
	onClose?: () => void;
}

function isActionable(t: EquipTarget, lockedReason?: string): boolean {
	return t.state !== "via-bundle" && !lockedReason && !t.disabledReason;
}

/**
 * The single equip control (D1). Given a subject and candidate targets, renders
 * each target's on/off/via-bundle state and a one-click Toggle, driven by one
 * `onToggle` slot. Owns search, roving keyboard nav, optimistic pending +
 * revert, and via-bundle read-only rows (which link to the providing bundle).
 */
export function EquipPicker({
	subject,
	targets,
	onToggle,
	loading,
	searchPlaceholder = "Filter…",
	emptyLabel,
	footer,
	variant = "popover",
	filterThreshold = 0,
	listLabel,
	toggleLabel,
	lockedReason,
	settledLabel = "synced",
	onClose,
}: EquipPickerProps) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	// Optimistic overrides (on/off) per target id + in-flight set.
	const [overrides, setOverrides] = useState<Record<string, "on" | "off">>({});
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	// Rows that just settled (onToggle resolved) — held for SETTLED_HOLD_MS
	// then removed. One timer per row so a fresh toggle can cancel the old one.
	const [settled, setSettled] = useState<Set<string>>(() => new Set());
	const settledTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const timers = settledTimers.current;
		return () => {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		};
	}, []);

	// Drop an override once the incoming prop settles to the same value (the
	// react-query optimistic write has landed) so external truth wins again.
	useEffect(() => {
		setOverrides((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const t of targets) {
				const ov = next[t.id];
				if (ov !== undefined && !pending.has(t.id) && ov === t.state) {
					delete next[t.id];
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [targets, pending]);

	const effState = useCallback(
		(t: EquipTarget): EquipState => overrides[t.id] ?? t.state,
		[overrides],
	);

	const filtered = useMemo(() => {
		const lq = query.trim().toLowerCase();
		if (!lq) return targets;
		return targets.filter((t) => t.name.toLowerCase().includes(lq));
	}, [targets, query]);

	// Keep the roving index in range as the filter changes.
	useEffect(() => {
		setActive((a) => (a >= filtered.length ? Math.max(0, filtered.length - 1) : a));
	}, [filtered.length]);

	const toggle = useCallback(
		async (t: EquipTarget) => {
			if (!isActionable(t, lockedReason) || pending.has(t.id)) return;
			const cur = overrides[t.id] ?? (t.state === "on" ? "on" : "off");
			const next = cur === "on" ? "off" : "on";
			// A fresh toggle on a still-settled row cancels its hold — the two
			// states are mutually exclusive.
			const existingTimer = settledTimers.current.get(t.id);
			if (existingTimer !== undefined) {
				clearTimeout(existingTimer);
				settledTimers.current.delete(t.id);
			}
			setSettled((p) => {
				if (!p.has(t.id)) return p;
				const n = new Set(p);
				n.delete(t.id);
				return n;
			});
			setOverrides((p) => ({ ...p, [t.id]: next }));
			setPending((p) => new Set(p).add(t.id));
			try {
				await onToggle(t, next);
				setSettled((p) => new Set(p).add(t.id));
				const timer = setTimeout(() => {
					setSettled((p) => {
						const n = new Set(p);
						n.delete(t.id);
						return n;
					});
					settledTimers.current.delete(t.id);
				}, SETTLED_HOLD_MS);
				settledTimers.current.set(t.id, timer);
			} catch {
				// Revert to the pre-toggle prop state.
				setOverrides((p) => {
					const n = { ...p };
					delete n[t.id];
					return n;
				});
			} finally {
				setPending((p) => {
					const n = new Set(p);
					n.delete(t.id);
					return n;
				});
			}
		},
		[onToggle, overrides, pending, lockedReason],
	);

	const onKeyDown = useCallback(
		(e: ReactKeyboardEvent) => {
			// A row's own control (the Toggle checkbox) handles its own keys: the
			// roving index follows the mouse, so Space there must not toggle
			// whichever row was last hovered.
			if ((e.target as HTMLElement).closest(".equip-badges")) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((a) => Math.min(a + 1, filtered.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((a) => Math.max(a - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const t = filtered[active];
				if (t) void toggle(t);
			} else if (e.key === " " && query.trim() === "") {
				// Space toggles only when it can't disturb typing a filter.
				e.preventDefault();
				const t = filtered[active];
				if (t) void toggle(t);
			} else if (e.key === "Escape") {
				if (query) {
					e.preventDefault();
					setQuery("");
					return;
				}
				if (variant === "popover" && onClose) {
					e.preventDefault();
					onClose();
				}
			}
		},
		[filtered, active, toggle, query, variant, onClose],
	);

	const body = (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role="group" is the composite listbox's own arrow-key/Enter navigation host (search input + option list below), not a stray listener on inert markup.
		<div
			className={`equip-picker equip-${variant}`}
			role="group"
			// `listLabel` already exists so two inline listboxes in one section
			// don't share a name (rule 8) — fold it into the GROUP name too, or
			// two pickers with the same subject (e.g. the bundle editor's APPLIED
			// TO and SKILLS, both `{kind:"bundle", name: bundleName}`) announce as
			// two identical "Equip <bundle>" groups (m2).
			aria-label={
				listLabel ? `Equip ${subject.name} — ${listLabel}` : `Equip ${subject.name}`
			}
			onKeyDown={onKeyDown}
		>
			{targets.length > filterThreshold && (
				<div className="equip-picker-search">
					<SearchInput
						value={query}
						onChange={setQuery}
						placeholder={searchPlaceholder}
						autoFocus={variant === "popover"}
					/>
				</div>
			)}
			{lockedReason && (
				<div className="equip-picker-lock">
					<Icon name="warning" size={10} /> {lockedReason}
				</div>
			)}
			<div
				className="equip-picker-list"
				role="listbox"
				aria-label={listLabel ?? `${subject.name} targets`}
				tabIndex={0}
				aria-activedescendant={
					filtered[active] ? `equip-opt-${filtered[active].id}` : undefined
				}
				ref={listRef}
			>
				{loading ? (
					<div className="equip-picker-empty">Loading…</div>
				) : filtered.length === 0 ? (
					<div className="equip-picker-empty">
						{emptyLabel ?? "No matching targets."}
					</div>
				) : (
					filtered.map((t, idx) => {
						const st = effState(t);
						const isPending = pending.has(t.id);
						const isSettled = settledLabel !== false && settled.has(t.id);
						const actionable = isActionable(t, lockedReason);
						// The checkbox IS the on/off state — a second ON/OFF pill beside it
						// said the same thing twice. A via-bundle row has no checkbox: its
						// provenance rides in the meta slot every row shares (`via android`,
						// linked) and a dim bundle glyph holds the checkbox's column.
						const viaMeta =
							st === "via-bundle" ? (
								<span className="equip-meta equip-provider" {...clickSink()}>
									via{" "}
									{t.providedBy && t.providedBy.length > 0
										? t.providedBy.map((p, i) => (
												<span key={p.name}>
													{i > 0 && ", "}
													<Link to={p.href} className="equip-provider-link">
														{p.name}
													</Link>
												</span>
											))
										: "bundle"}
								</span>
							) : null;
						// Settled: a via-bundle row never toggles, so it never
						// settles — the word replaces the meta slot only for a row
						// with a checkbox.
						const settledMeta = isSettled ? (
							<span className="equip-meta equip-settled">{settledLabel}</span>
						) : null;
						return (
							// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- composite listbox option (aria-selected + owning listbox's onKeyDown/aria-activedescendant below); the option itself is never a separate tab stop.
							<div
								key={t.id}
								id={`equip-opt-${t.id}`}
								role="option"
								aria-selected={idx === active}
								aria-disabled={!actionable || undefined}
								className="equip-option"
								data-active={idx === active || undefined}
								data-pending={isPending || undefined}
								data-settled={isSettled || undefined}
								aria-busy={isPending || undefined}
								data-state={st}
								onMouseEnter={() => setActive(idx)}
								onClick={() => actionable && void toggle(t)}
								// The consequence of a toggle is a hover fact, not a third
								// line on every row — and while lockedReason is in force
								// that fact (not a moot per-target blastRadius) is the hover.
								title={
									variant === "inline"
										? (lockedReason ?? t.blastRadius)
										: undefined
								}
							>
								<ResourceRow
									glyph={t.glyph}
									name={t.name}
									meta={viaMeta ?? settledMeta ?? (
										subject.kind === "skill" && st !== "via-bundle" && isValidElement(t.meta) &&
											String((t.meta.props as { className?: string }).className).includes("equip-path")
											? <ProspectiveCostCell name={subject.name} />
											: t.meta
									)}
									desc={
										// A list-level lock states the reason ONCE, above the
										// list — a per-row disabledReason line here would repeat
										// it once per target.
										!lockedReason && t.disabledReason ? (
											<span className="equip-disabled-reason">
												<Icon name="warning" size={10} /> {t.disabledReason}
											</span>
										) : variant === "popover" && t.blastRadius ? (
											<span className="equip-blast">{t.blastRadius}</span>
										) : undefined
									}
									badges={
										<span className="equip-badges" {...clickSink()}>
											{st === "via-bundle" && (
												<Icon
													name="bundle"
													size={13}
													className="equip-via-glyph"
													title="Provided by a bundle"
												/>
											)}
											{isPending ? (
												<span role="status" aria-label={`Updating ${t.name}`}>
													<Spinner size={12} color="currentColor" />
												</span>
											) : (
												t.state !== "via-bundle" && (
													<Toggle
														variant="checkbox"
														size="sm"
														checked={st === "on"}
														disabled={!actionable}
														ariaLabel={
															toggleLabel
																? toggleLabel(t, st)
																: `${st === "on" ? "Unequip" : "Equip"} ${subject.name} ${
																		t.name
																	}`
														}
														onChange={() => void toggle(t)}
													/>
												)
											)}
										</span>
									}
								/>
							</div>
						);
					})
				)}
			</div>
			{footer && <div className="equip-picker-foot">{footer}</div>}
		</div>
	);

	if (variant === "popover") {
		return (
			<>
				<div
					className="equip-popover-scrim"
					onMouseDown={() => onClose?.()}
					aria-hidden="true"
				/>
				{body}
			</>
		);
	}
	return body;
}
