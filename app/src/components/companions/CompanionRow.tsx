// D7 — one dense row per companion (Approach 2: "the row is data-thin").
// `CompanionRow` never computes a `CompanionState` itself — it takes the
// `DeclRow` (declared shape) plus whatever live `CompanionItem[]` the read
// produced for it and renders icon · name (a hover-carded link) · a neutral
// state `Tag`/menu · the harness glyph cluster. The one action this row DOES
// own outright is I9 (drift resolve) — a real mutation, not derived state.

import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";
import { useToast } from "@/components/Toast";
import { hubCmd } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { companionRoute } from "@/lib/companionRoutes";
import { glyphStateFor, type CompanionItem, type CompanionResolveOp, type DeclKind, type DeclRow } from "@/lib/companions";
import { CompanionHarnessGlyphs, type CompanionHarnessState } from "./CompanionHarnessGlyphs";
import { CompanionRefCard } from "./CompanionRefCard";

const KIND_ICON: Record<DeclKind, string> = {
	agent: "agent",
	hook: "hook",
	permission: "permissions",
};

/** R30: the ONE label map for a row's aggregate badge — `drift` reads
 *  "drifted" wherever it renders (the `DriftControl` menu's own Tag AND the
 *  plain fallback Tag for a non-`agent` row that somehow carries a `drift`
 *  item), never the raw state word in one branch and the human word in the
 *  other. F4 adds `absent`: a neutral `Tag` reading "not installed" in the
 *  same slot. Good-ux: job is telling "declared only, not installed
 *  anywhere" apart from "already here" at a glance; frequency is every row
 *  in a many-row scan, and pre-equip is the common state, not the rare one;
 *  error cost of missing it is high — a hover-only signal reads as "this
 *  exists" to anyone who doesn't hover, which is simply wrong (never amber;
 *  a capability gap is neither provenance nor risk, S2). */
const BADGE_LABEL: Record<"drift" | "outdated" | "missing" | "absent", string> = {
	drift: "drifted",
	outdated: "outdated",
	missing: "missing",
	// W3: "not provisioned" — not "not installed". The section's own status
	// line already says "Provisioned on …"/"Not provisioned anywhere" for the
	// identical fact; a hook row is also routable (the definition genuinely
	// exists), so "installed" was flatly wrong one click away. One word, one
	// meaning, in one panel.
	absent: "not provisioned",
};

/** Stable per-row key — a permission row disambiguates on `rule_kind` too
 *  (the same pattern can appear under `deny` and `ask`). Exported so
 *  `ShipsWithSection` uses the SAME key for its React `key` prop and for
 *  whatever it needs to look the row up by. */
export function companionRowKey(row: DeclRow): string {
	if (row.kind === "permission") return `permission:${row.rule_kind}:${row.name}`;
	return `${row.kind}:${row.name}`;
}

/** One glyph state per harness this row's live read reported — `item.state`
 *  is typed optional (an older/partial fixture may omit it); a row this
 *  component actually renders always came from a wave-2 read, so this is a
 *  defensive fallback, not an expected case. */
function rowGlyphStates(items: CompanionItem[]): CompanionHarnessState[] {
	return items.map((i) => ({ harness: i.harness, state: i.state ?? "missing", reason: i.reason }));
}

/** The row's own aggregate badge (Approach 6/Risk 3, F4): a row can carry
 *  several per-harness items, but the ASCII sketch shows at most one state
 *  word per row — drift outranks outdated outranks missing outranks absent.
 *  `stale` never reaches here (a stale item has no matching declared row to
 *  attach to). `absent` fires when nothing on the row is lit (provisioned/
 *  present/drift/outdated) and at least one item genuinely is `absent` — an
 *  `unsupported` sibling does not veto it (F4: "declared only, not installed
 *  anywhere" must be legible at a glance, not only on hover). */
function rowBadge(items: CompanionItem[]): "drift" | "outdated" | "missing" | "absent" | null {
	if (items.some((i) => i.state === "drift")) return "drift";
	if (items.some((i) => i.state === "outdated")) return "outdated";
	if (items.some((i) => i.state === "missing")) return "missing";
	const lit = items.some((i) => i.state != null && glyphStateFor(i.state) === "lit");
	if (!lit && items.some((i) => i.state === "absent")) return "absent";
	return null;
}

/** Hover-managed name link, mirroring `PreviewRefLink`'s 250ms open / 120ms
 *  close grace (Design-language conformance) — moving the pointer from the
 *  anchor onto the card must not dismiss it. F7: when there is nowhere to
 *  navigate (`companionRoute` returned `null` — a project-less rule with no
 *  `route`, or a hook this reader has no library-verified link for), the
 *  anchor is a plain `<span>`, not a focusable-but-inert `<button>`. Good-ux:
 *  job is naming an inert companion without inviting a click that goes
 *  nowhere; frequency is every row in a many-row scan (the card is bound to
 *  mouse events only, no `onFocus`, so a kept button buys nothing); error
 *  cost of the wrong choice is a dead keyboard stop per row that announces
 *  nothing a screen reader doesn't already get from the glyph cluster's own
 *  `aria-label`s. Both forms carry `data-routable` so the stylesheet keys the
 *  pointer affordance on ONE attribute rather than the element type. */
function CompanionNameLink({
	row,
	items,
	skill,
	description,
	hookNames,
}: {
	row: DeclRow;
	items: CompanionItem[];
	skill: string;
	description?: string;
	hookNames?: Set<string> | null;
}) {
	const [open, setOpen] = useState(false);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const navigate = useNavigate();
	const anchorRef = useRef<HTMLButtonElement | HTMLSpanElement | null>(null);
	const panelRef = useRef<HTMLSpanElement | null>(null);
	// R29: `.editor-side` (editor.css) is a scroll container — an `absolute`
	// popover positioned inside it cannot escape that box, so a card near the
	// panel's edge clips. Portalled + `position: fixed`, measured off the
	// anchor's own rect (the `OverflowMenu`/`Popover` pattern — GAP/EDGE below
	// match theirs), the card floats over the whole viewport instead. `null` =
	// "not positioned yet" (rendered invisible for one layout pass, never a
	// visible jump).
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const POPOVER_GAP = 4;
	const POPOVER_EDGE = 4;

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		const anchor = anchorRef.current;
		const panel = panelRef.current;
		if (!anchor || !panel) return;
		const a = anchor.getBoundingClientRect();
		const p = panel.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		const spaceBelow = vh - a.bottom;
		const flipUp = spaceBelow < p.height + POPOVER_GAP && a.top > p.height + POPOVER_GAP;
		const top = flipUp ? a.top - p.height - POPOVER_GAP : a.bottom + POPOVER_GAP;
		const left = Math.max(POPOVER_EDGE, Math.min(a.left, vw - p.width - POPOVER_EDGE));
		setPos({ top, left });
	}, [open]);

	// A scroll/resize anywhere invalidates the measured position outright —
	// closing (rather than chasing a moving target) matches `OverflowMenu`'s
	// own dismissal and is more than adequate for a transient hover card.
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	useEffect(
		() => () => {
			if (openTimer.current) clearTimeout(openTimer.current);
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	const handleEnter = () => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		if (open || openTimer.current) return;
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setOpen(true);
		}, 250);
	};
	const handleLeave = () => {
		if (openTimer.current) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
		if (closeTimer.current) return;
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setOpen(false);
		}, 120);
	};

	// F9: the whole per-harness list, not just `items[0]` — an agent lit only
	// on a non-first harness used to go unrouted.
	const nav = companionRoute(row, items, { skill, hookNames });
	const onOpen = nav ? () => navigate(nav.path, nav.options) : undefined;
	const routable = nav !== null;

	return (
		<span className="companion-name-anchor">
			{routable ? (
				<button
					ref={anchorRef as unknown as Ref<HTMLButtonElement>}
					type="button"
					className="companion-name text-mono"
					title={row.name}
					data-testid="companion-name"
					data-routable="true"
					onMouseEnter={handleEnter}
					onMouseLeave={handleLeave}
					onClick={onOpen}
				>
					{row.name}
				</button>
			) : (
				// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- deliberately inert (F7): a hover-only host for the info card, never a tab stop (the card never opens on focus either, no onFocus). The state it would reveal is already carried, keyboard-accessible, by the glyph cluster's own aria-label/sr-only sentence.
				<span
					ref={anchorRef as unknown as Ref<HTMLSpanElement>}
					className="companion-name text-mono"
					title={row.name}
					data-testid="companion-name"
					data-routable="false"
					onMouseEnter={handleEnter}
					onMouseLeave={handleLeave}
				>
					{row.name}
				</span>
			)}
			{open &&
				createPortal(
					// `role="presentation"`: this wrapper carries no meaning of its own
					// (mirrors `.md-skill-ref-popover`'s intent) — the real interactive
					// content is `CompanionRefCard`'s own `onOpen` button inside it.
					// Portalled to `document.body` + `position: fixed` (R29): a
					// `.editor-side` ancestor scrolls, so an `absolute` popover could
					// never escape its clipping box.
					<span
						ref={panelRef}
						className="companion-popover"
						role="presentation"
						data-testid="companion-popover"
						onMouseEnter={handleEnter}
						onMouseLeave={handleLeave}
						style={
							pos
								? { top: pos.top, left: pos.left, visibility: "visible" }
								: { top: 0, left: 0, visibility: "hidden" }
						}
					>
						<CompanionRefCard
							kind={row.kind}
							name={row.name}
							description={description}
							harnesses={rowGlyphStates(items)}
							onOpen={onOpen}
						/>
					</span>,
					document.body,
				)}
		</span>
	);
}

/** The `drifted` row's Tag + I9 `OverflowMenu` (A20/C6) — `keep-mine` /
 *  `keep-skill`, run through a plain `hubCmd` (not the companion gate: this is
 *  not an `enable`). Success invalidates every `skill-companions` read
 *  (`qk.skillCompanionsAll()`) so every open panel picks up the resolved
 *  state on its next render. */
function DriftControl({
	agent,
	skill,
	project,
	projectContext,
}: {
	agent: string;
	skill: string;
	project: string | null;
	projectContext: boolean;
}) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const [busy, setBusy] = useState(false);

	const runOp = async (op: CompanionResolveOp) => {
		setBusy(true);
		try {
			const args = ["skill", "companions", "resolve", skill, "--agent", agent, "--op", op];
			if (project) args.push("--project", project);
			else if (projectContext) args.push("--global");
			const result = await hubCmd(args);
			if (!result.success) {
				toast.error("Couldn't resolve drift", result.output || undefined);
				return;
			}
			await queryClient.invalidateQueries({ queryKey: qk.skillCompanionsAll() });
			toast.success(op === "keep-mine" ? "Kept your copy" : "Kept the skill's copy");
		} finally {
			setBusy(false);
		}
	};

	const items: OverflowMenuItem[] = [
		{ label: "Keep mine", onClick: () => void runOp("keep-mine"), busy },
		{ label: "Keep the skill's", onClick: () => void runOp("keep-skill"), busy },
	];

	return (
		<span className="companion-state-control" data-testid={`companion-drift-${agent}`}>
			<Tag size="sm">{BADGE_LABEL.drift}</Tag>
			<OverflowMenu triggerSize="sm" align="right" label={`Resolve drift on ${agent}`} items={items} />
		</span>
	);
}

export interface CompanionRowProps {
	row: DeclRow;
	/** The live read's items for this row — one per harness reported, `[]`
	 *  before the query resolves or when the row has no live data yet. */
	items: CompanionItem[];
	skill: string;
	/** Resolved by the caller (`ShipsWithSection`): agent frontmatter
	 *  description, hook "<event> · <command>" (ref or inline), or rule
	 *  "<kind> · <pattern>". */
	description?: string;
	/** The project this read is scoped to, or `null` for a project-less or
	 *  global-scope read. Threaded through to I9 (drift resolve) only. */
	project?: string | null;
	/** True for a `scope: global` skill's own-scope read (A17) — `project`
	 *  stays `null` there, so I9 uses `--global` instead. */
	projectContext?: boolean;
	/** F2: names the hooks LIBRARY resolves (`hook_list`) — passed straight
	 *  through to `companionRoute`'s hook gate. Irrelevant for an agent/
	 *  permission row. S4: `null` (as opposed to `undefined`, still pending)
	 *  means the library read FAILED — `companionRoute` then falls back to
	 *  the CLI's own route instead of inerting every hook row. */
	hookNames?: Set<string> | null;
	/** FRAME TWEAK: whether an `absent` row may wear the "not provisioned"
	 *  badge. `ShipsWithSection` computes this ONCE per render from the whole
	 *  payload — true only when at least one row in the section is lit
	 *  (provisioned/present) — because the job here is scanning a list of up
	 *  to a dozen companions at a glance, and when EVERY row is absent
	 *  (the idle "Not provisioned anywhere" line already covers it) a badge
	 *  repeated on every single name differentiates nothing: it is not a
	 *  signal, it is noise that visually truncates the one thing that still
	 *  varies — the name itself (good-ux: the chrome should disappear into
	 *  the task, not compete with it). Defaults to `true` so every other
	 *  caller keeps today's per-row badge. */
	absentBadge?: boolean;
}

export function CompanionRow({
	row,
	items,
	skill,
	description,
	project,
	projectContext = false,
	hookNames,
	absentBadge = true,
}: CompanionRowProps) {
	const badge = rowBadge(items);
	const showBadge = badge !== null && (badge !== "absent" || absentBadge);
	const key = companionRowKey(row);
	return (
		<div className="companion-row" data-testid={`companion-row-${key}`}>
			<Icon
				name={KIND_ICON[row.kind]}
				size={13}
				tone="mute"
				title={row.kind}
				className="companion-row-icon"
			/>
			<CompanionNameLink
				row={row}
				items={items}
				skill={skill}
				description={description}
				hookNames={hookNames}
			/>
			<span className="companion-row-right">
				{badge === "drift" && row.kind === "agent" ? (
					<DriftControl
						agent={row.name}
						skill={skill}
						project={project ?? null}
						projectContext={projectContext}
					/>
				) : showBadge ? (
					<span data-testid={`companion-badge-${key}`}>
						<Tag size="sm">{BADGE_LABEL[badge as "outdated" | "missing" | "absent"]}</Tag>
					</span>
				) : null}
				<CompanionHarnessGlyphs states={rowGlyphStates(items)} />
			</span>
		</div>
	);
}
