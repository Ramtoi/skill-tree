import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { ResourceRow } from "./ResourceRow";
import { StatusBadge } from "./StatusBadge";
import { Toggle } from "./Toggle";
import { SearchInput } from "./SearchInput";
import { Icon } from "./Icon";

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
	/** Consequence hint surfaced on hover/focus (e.g. "N projects lose this skill"). */
	blastRadius?: ReactNode;
	/** Non-actionable with a reason (e.g. affinity mismatch). */
	disabledReason?: string;
}

export interface EquipPickerProps {
	subject: { kind: "skill" | "bundle" | "remote"; name: string };
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
	onClose?: () => void;
}

function isActionable(t: EquipTarget): boolean {
	return t.state !== "via-bundle" && !t.disabledReason;
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
	onClose,
}: EquipPickerProps) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	// Optimistic overrides (on/off) per target id + in-flight set.
	const [overrides, setOverrides] = useState<Record<string, "on" | "off">>({});
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const listRef = useRef<HTMLDivElement | null>(null);

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
			if (!isActionable(t) || pending.has(t.id)) return;
			const cur = overrides[t.id] ?? (t.state === "on" ? "on" : "off");
			const next = cur === "on" ? "off" : "on";
			setOverrides((p) => ({ ...p, [t.id]: next }));
			setPending((p) => new Set(p).add(t.id));
			try {
				await onToggle(t, next);
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
		[onToggle, overrides, pending],
	);

	const onKeyDown = useCallback(
		(e: ReactKeyboardEvent) => {
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
		<div
			className={`equip-picker equip-${variant}`}
			role="group"
			aria-label={`Equip ${subject.name}`}
			onKeyDown={onKeyDown}
		>
			<div className="equip-picker-search">
				<SearchInput
					value={query}
					onChange={setQuery}
					placeholder={searchPlaceholder}
					autoFocus={variant === "popover"}
				/>
			</div>
			<div
				className="equip-picker-list"
				role="listbox"
				aria-label={`${subject.name} targets`}
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
						const actionable = isActionable(t);
						const badge =
							st === "on" ? (
								<StatusBadge channel="ok" shape="dot">
									ON
								</StatusBadge>
							) : st === "via-bundle" ? (
								<StatusBadge channel="neutral" icon="bundle">
									via bundle
								</StatusBadge>
							) : (
								<StatusBadge channel="neutral">OFF</StatusBadge>
							);
						return (
							<div
								key={t.id}
								id={`equip-opt-${t.id}`}
								role="option"
								aria-selected={idx === active}
								aria-disabled={!actionable || undefined}
								className="equip-option"
								data-active={idx === active || undefined}
								data-pending={isPending || undefined}
								data-state={st}
								onMouseEnter={() => setActive(idx)}
								onClick={() => actionable && void toggle(t)}
							>
								<ResourceRow
									glyph={t.glyph}
									name={t.name}
									meta={t.meta}
									desc={
										!actionable && t.state === "via-bundle" && t.providedBy ? (
											<span
												className="equip-provider"
												onClick={(e) => e.stopPropagation()}
											>
												managed by{" "}
												{t.providedBy.map((p, i) => (
													<span key={p.name}>
														{i > 0 && ", "}
														<Link to={p.href} className="equip-provider-link">
															{p.name}
														</Link>
													</span>
												))}
											</span>
										) : t.disabledReason ? (
											<span className="equip-disabled-reason">
												<Icon name="warning" size={10} /> {t.disabledReason}
											</span>
										) : t.blastRadius ? (
											<span className="equip-blast">{t.blastRadius}</span>
										) : undefined
									}
									badges={
										<span
											className="equip-badges"
											onClick={(e) => e.stopPropagation()}
										>
											{badge}
											{t.state !== "via-bundle" && (
												<Toggle
													variant="checkbox"
													size="sm"
													checked={st === "on"}
													disabled={!actionable || isPending}
													ariaLabel={`${st === "on" ? "Unequip" : "Equip"} ${subject.name} ${
														t.name
													}`}
													onChange={() => void toggle(t)}
												/>
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
