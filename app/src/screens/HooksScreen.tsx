import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Tag } from "@/components/Tag";
import { HookReachBadges } from "@/components/HookReachBadges";
import { useListNav } from "@/hooks/useListNav";
import { useHookList, useHookCapabilities, type HookRow } from "@/hooks/useHooks";

/** Route helper the rail/palette/chord wave (`g k`, `c h`) navigates to. */
export const HOOKS_ROUTE = "/hooks";
export function hookRoute(name: string): string {
	return `/hook/${encodeURIComponent(name)}`;
}
/** The create route: HookEditor treats the `name` param `"new"` as create mode. */
export const HOOK_NEW_ROUTE = "/hook/new";

/**
 * Hook library (`/hooks`, hooks-surface D7). Rows show name (mono), event tag,
 * tools chips, provenance (builtin/user), and per-harness reach badges from the
 * probe cache. Keyboard list-nav (`j`/`k`/Enter) opens the editor. The later
 * wave wires the rail item, the `g k` chord, and the `c h` create chord; this
 * screen already exposes a working "New hook" action.
 */
export function HooksScreen() {
	const navigate = useNavigate();
	const { data, isLoading, error } = useHookList();
	const { data: capabilities } = useHookCapabilities();
	const hooks = data?.hooks ?? [];

	const nav = useListNav({
		count: hooks.length,
		onOpen: (i) => {
			const h = hooks[i];
			if (h) navigate(hookRoute(h.name));
		},
	});

	return (
		<>
			<ScreenHeader
				leading={<Icon name="bolt" size={14} />}
				title="Hooks"
				meta={<Tag size="sm">{hooks.length} defined</Tag>}
				subline="Event-driven commands that fire on tool use, prompts, and session lifecycle · per-harness reach"
				primary={
					<Button
						variant="primary"
						icon="plus"
						onClick={() => navigate(HOOK_NEW_ROUTE)}
					>
						New hook
					</Button>
				}
			/>

			<div className="hooks-screen">
				{error ? (
					<EmptyState
						icon="warning"
						title="Could not load hooks"
						description={String(error)}
					/>
				) : isLoading ? (
					<div className="hooks-loading text-dim">Loading hooks…</div>
				) : hooks.length === 0 ? (
					<EmptyState
						icon="bolt"
						title="No hooks yet"
						description="Hooks run a command when an event fires — after an edit, on a prompt, at session start. Create one to lint after edits, gate a tool, or notify on stop."
						action={
							<Button
								variant="primary"
								icon="plus"
								onClick={() => navigate(HOOK_NEW_ROUTE)}
							>
								Create your first hook
							</Button>
						}
					/>
				) : (
					<div className="hooks-list" aria-label="Hooks" {...nav.containerProps}>
						{hooks.map((h, i) => (
							<HookRowItem
								key={h.name}
								hook={h}
								capabilities={capabilities}
								itemProps={nav.itemProps(i)}
								onOpen={() => navigate(hookRoute(h.name))}
							/>
						))}
					</div>
				)}
			</div>
		</>
	);
}

// ─── One library row ──────────────────────────────────────────────────────────

const TOOLS_SHOWN = 4;

function HookRowItem({
	hook,
	capabilities,
	itemProps,
	onOpen,
}: {
	hook: HookRow;
	capabilities: Parameters<typeof HookReachBadges>[0]["capabilities"];
	itemProps: ReturnType<ReturnType<typeof useListNav>["itemProps"]>;
	onOpen: () => void;
}) {
	const extraTools = Math.max(0, hook.tools.length - TOOLS_SHOWN);
	return (
		<div
			className="hook-row"
			role="option"
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					// Stop the event from bubbling to the listbox container, whose own
					// onKeyDown (from useListNav) ALSO opens the active item on Enter —
					// without this, the row's handler and the container's handler both
					// fire for the same keypress, double-navigating.
					e.stopPropagation();
					onOpen();
				}
			}}
			{...(itemProps as Record<string, unknown>)}
		>
			<div className="hook-row-main">
				<div className="hook-row-title">
					<span className="hook-name text-mono">{hook.name}</span>
					<Tag size="sm" className="hook-provenance">
						{hook.provenance}
					</Tag>
				</div>
				{hook.description && (
					<div className="hook-row-desc text-dim">{hook.description}</div>
				)}
			</div>

			<div className="hook-row-matchers">
				<Tag size="sm" kind="outline" className="hook-event">
					<span className="text-mono">{hook.event || "—"}</span>
				</Tag>
				<div className="hook-tools">
					{hook.matcher ? (
						<Tag size="sm" className="hook-tool">
							<span className="text-mono" title={`raw matcher: ${hook.matcher}`}>
								/{hook.matcher}/
							</span>
						</Tag>
					) : hook.tools.length === 0 ? (
						<span className="text-dim hook-tools-all">all tools</span>
					) : (
						<>
							{hook.tools.slice(0, TOOLS_SHOWN).map((t) => (
								<Tag key={t} size="sm" className="hook-tool">
									<span className="text-mono">{t}</span>
								</Tag>
							))}
							{extraTools > 0 && (
								<span className="text-dim" title={hook.tools.join(", ")}>
									+{extraTools}
								</span>
							)}
						</>
					)}
				</div>
			</div>

			<div className="hook-row-reach">
				<HookReachBadges capabilities={capabilities} />
			</div>
		</div>
	);
}
