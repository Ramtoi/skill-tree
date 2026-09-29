import { useCallback, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface SidePanelSectionProps {
	/** Stable id — the persistence key inside the section map and the suffix of
	 *  the head's `data-testid` (`side-section-<id>`). */
	id: string;
	title: string;
	/** Numeric badge next to the title (`FILES · 16`). */
	count?: number;
	/** Closed-state summary. Rendered OUTSIDE the toggle button so it may hold
	 *  chips, links and dots without nesting interactive content. */
	summary?: ReactNode;
	defaultOpen?: boolean;
	/** localStorage key of a `{ [sectionId]: boolean }` map. Omit for a section
	 *  whose open state is session-only. */
	storageKey?: string;
	/** Show the body regardless of the toggled/stored state — a closed section
	 *  must never be the only place a staged edit lives. While forced, the
	 *  head's toggle is DISABLED: a live `aria-expanded="true"` on a control
	 *  whose press does nothing would be a dead affordance, and letting the
	 *  press through would persist `false` to `storageKey` — collapsing the
	 *  section on its own the instant the draft is saved or discarded, with no
	 *  action from the user at that moment. The user's own last toggle is
	 *  remembered underneath and takes over again once `forceOpen` clears. */
	forceOpen?: boolean;
	/** Extra class on the section root (e.g. a "this is the primary editable
	 *  block" marker). */
	className?: string;
	/** Hover text on the head — an explanation too situational to keep on
	 *  screen at all times (COMPONENTS.md rule 9: "the rest rides in title"). */
	headTitle?: string;
	children: ReactNode;
}

/** Read the `{ [id]: open }` map behind `storageKey`, tolerating absent,
 *  unparseable or non-object values (a hand-edited localStorage entry must
 *  degrade to "use the defaults", never throw during render). */
export function readSectionState(storageKey: string): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, boolean>;
	} catch {
		return {};
	}
}

/** Merge one section's flag into the stored map. Read-modify-write, because
 *  every section on the panel shares the same key and they mount independently. */
function writeSectionState(storageKey: string, id: string, open: boolean) {
	try {
		const map = readSectionState(storageKey);
		map[id] = open;
		localStorage.setItem(storageKey, JSON.stringify(map));
	} catch {
		/* private mode / quota — persistence is a convenience, never a blocker */
	}
}

/** S3: opens (if collapsed) and scrolls a sibling `SidePanelSection` into
 *  view by its `id` — the one imperative escape hatch for a button in ONE
 *  section that needs to point at a DIFFERENT section on the same panel
 *  (`McpPanel`'s "Change reach" → REACH; `ShipsWithSection`'s idle-line
 *  "Equip…" → the used-by/`EquipPicker` section). Good-ux: that job — send
 *  the reader to where the actual control lives — is occasional (once per
 *  skill/server, not a rare one-off) and reversible, which earns one
 *  discoverable action here instead of a dead-end sentence describing a
 *  control a few sections up on the SAME panel. Imperative by necessity: no
 *  prop path exists between two independently-mounted sections of the same
 *  panel tree. */
export function openSidePanelSection(id: string) {
	const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="side-section-${id}"]`);
	if (!toggle) return;
	if (toggle.getAttribute("aria-expanded") === "false") toggle.click();
	toggle.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * The one disclosure grammar for editor side panels: a chevron head carrying a
 * title, an optional count and an optional summary, over a body that mounts
 * only while open.
 *
 * Extracted from `ConnectionsPanel`'s local `Section` so the skill editor's
 * FILES / DETAILS / TRIGGERING blocks and the connections blocks are literally
 * the same component — half the panel used to speak the newer design language
 * and half did not.
 */
export function SidePanelSection({
	id,
	title,
	count,
	summary,
	defaultOpen,
	storageKey,
	forceOpen,
	className,
	headTitle,
	children,
}: SidePanelSectionProps) {
	const [openState, setOpen] = useState<boolean>(() => {
		if (storageKey) {
			const stored = readSectionState(storageKey);
			if (typeof stored[id] === "boolean") return stored[id];
		}
		return !!defaultOpen;
	});
	const open = forceOpen || openState;

	// Forced-open is not a real toggle: a press must neither persist a value
	// (it is not the reader's own preference) nor flip `openState` underneath
	// — that would self-collapse the section the instant `forceOpen` lifts.
	// The head disables instead, so `aria-expanded` (always `open`) stays
	// honest with what a press can actually do.
	const toggle = useCallback(() => {
		if (forceOpen) return;
		setOpen((prev) => {
			const next = !prev;
			if (storageKey) writeSectionState(storageKey, id, next);
			return next;
		});
	}, [id, storageKey, forceOpen]);

	const forcedTitle = "Has unsaved changes — stays open until saved.";

	return (
		<section
			className={`side-panel-section${className ? ` ${className}` : ""}`}
			data-open={open || undefined}
			data-section-id={id}
		>
			{/* `headTitle` sits on the WHOLE row too — the summary text (e.g.
			    "fires on 1 of 3") is the most likely hover target on a head, and
			    it lives OUTSIDE the toggle button (so it may hold chips/links),
			    which meant hovering it showed no tooltip at all. */}
			<div
				className="side-panel-section-head-row"
				title={forceOpen ? forcedTitle : headTitle}
			>
				<button
					type="button"
					className="side-panel-section-head"
					aria-expanded={open}
					disabled={forceOpen}
					data-testid={`side-section-${id}`}
					title={forceOpen ? forcedTitle : headTitle}
					onClick={toggle}
				>
					<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
					<span className="side-panel-section-title">{title}</span>
					{count !== undefined && (
						<span className="side-panel-section-count">{count}</span>
					)}
				</button>
				{/* Summary lives OUTSIDE the toggle button so it may hold links/chips. */}
				<span className="side-panel-section-summary">{summary}</span>
			</div>
			{open && <div className="side-panel-section-body">{children}</div>}
		</section>
	);
}
