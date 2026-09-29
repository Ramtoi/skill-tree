import { fromNav, useBackTarget, backReturnOptions } from "@/lib/backTarget";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Tag } from "@/components/Tag";
import { HookReachBadges } from "@/components/HookReachBadges";
import { CompanionTag } from "@/components/companions/CompanionTag";
import { useListNav } from "@/hooks/useListNav";
import { useRegistry } from "@/hooks/useRegistry";
import { useShipWith } from "@/hooks/useShipWith";
import { eligibleShipTargets } from "@/lib/shipWith";
import {
	companionsIndex,
	activationWords,
	isHookRef,
	type CompanionActivation,
} from "@/lib/companions";
import type { Registry } from "@/types";
import {
	hookHealth,
	hookHealthChannel,
	hookHealthLabel,
	hookRunsLine,
	type HookHealth,
} from "@/lib/hookForm";
import {
	useHookList,
	useHookCapabilities,
	useHookDoctor,
	type HookAction,
	type HookDoctorFinding,
	type HookRow,
} from "@/hooks/useHooks";

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
 const back = useBackTarget({ label: "Hooks", path: "/hooks" });
 const openHook = (path: string) => navigate(path, fromNav({ label: "Hooks", path: "/hooks", restore: fromNav(back).state }));
	const { data, isLoading, error } = useHookList();
	const { data: capabilities } = useHookCapabilities();
	const { data: doctor } = useHookDoctor();
	const { data: registry } = useRegistry();
	const hooks = data?.hooks ?? [];
	const findings = doctor?.findings;
	// A11: the Hooks library is project-independent — "shipped by <skill>"
	// reads the registry mirror (`skills.<n>.ships_with`), never a ledger.
	const companions = useMemo(() => companionsIndex(registry), [registry]);
	// Suggestion 9 (opus review 6-review-4c.md) — `eligibleShipTargets`'s
	// `eligible.length`/`blocked.count` never depend on the target's own
	// `name`/`kind` (only on the registry's own skills: hub-owned, editable,
	// not remote-quarantined), so re-running the whole O(skills) scan inside
	// the `hooks.map` below — once per hook, every render — recomputed the
	// exact same answer every time. Hoisted here to run once per registry
	// change instead.
	const hasEligibleSkill = useMemo(
		() => eligibleShipTargets(registry, { kind: "hook", name: "" }).eligible.length > 0,
		[registry],
	);
	// Wave 4c unit 4 (plans/3.md §2.3/§5) — the reverse direction. `.open()`
	// is stable across renders (a plain hook wrapper over `getState`/
	// `setState`); the flow itself is mounted ONCE in `App.tsx`, next to
	// `CompanionGateProvider` — this screen never renders `shipWith.element`.
	const shipWith = useShipWith();

	const nav = useListNav({
		count: hooks.length,
		onOpen: (i) => {
			const h = hooks[i];
			if (h) openHook(hookRoute(h.name));
		},
	});

	return (
		<>
			<ScreenHeader
 back={back.path !== "/hooks" ? { label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) } : undefined}
				icon="hook"
				title="Hooks"
				meta={<Tag size="sm">{hooks.length} defined</Tag>}
				subline="Event-driven commands that fire on tool use, prompts, and session lifecycle · per-harness reach"
				primary={
					<Button
						variant="primary"
						icon="plus"
						onClick={() => openHook(HOOK_NEW_ROUTE)}
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
						icon="hook"
						title="No hooks yet"
						description="Hooks run a command when an event fires — after an edit, on a prompt, at session start. Create one to lint after edits, gate a tool, or notify on stop."
						action={
							<Button
								variant="primary"
								icon="plus"
								onClick={() => openHook(HOOK_NEW_ROUTE)}
							>
								Create your first hook
							</Button>
						}
					/>
				) : (
					<div className="hooks-list" aria-label="Hooks" {...nav.containerProps}>
						{hooks.map((h, i) => {
							const shippedBy = companions.shippedBy("hook", h.name);
							const target = { kind: "hook" as const, name: h.name };
							const canShipWith = !!shippedBy || hasEligibleSkill;
							return (
								<HookRowItem
									key={h.name}
									hook={h}
									capabilities={capabilities}
									findings={findings}
									itemProps={nav.itemProps(i)}
									onOpen={() => openHook(hookRoute(h.name))}
									shippedBy={shippedBy}
									activation={hookActivation(registry, companions, h.name)}
									onShipWith={
										canShipWith
											? () => shipWith.open(target, shippedBy?.skill ?? null)
											: undefined
									}
								/>
							);
						})}
					</div>
				)}
			</div>
		</>
	);
}

// ─── One library row ──────────────────────────────────────────────────────────

const TOOLS_SHOWN = 4;

/** A11: the declaring skill's own `activation` for THIS hook name, read from
 *  the mirror (`skills.<n>.ships_with.hooks`) — `companionsIndex.shippedBy`
 *  only answers *which* skill, not the per-hook activation word, so this
 *  walks the one matching skill's declared hooks. */
function hookActivation(
	registry: Registry | undefined,
	companions: ReturnType<typeof companionsIndex>,
	hookName: string,
): CompanionActivation | undefined {
	const skill = companions.shippedBy("hook", hookName)?.skill;
	if (!skill) return undefined;
	// A18/C5: a ref hook carries no inline `activation` to read.
	const entry = registry?.skills?.[skill]?.ships_with?.hooks?.find(
		(h) => h.name === hookName,
	);
	return entry && !isHookRef(entry) ? entry.activation : undefined;
}

function HookRowItem({
	hook,
	capabilities,
	findings,
	itemProps,
	onOpen,
	shippedBy,
	activation,
	onShipWith,
}: {
	hook: HookRow;
	capabilities: Parameters<typeof HookReachBadges>[0]["capabilities"];
	findings: HookDoctorFinding[] | undefined;
	itemProps: ReturnType<ReturnType<typeof useListNav>["itemProps"]>;
	onOpen: () => void;
	/** A11: the declaring skill, from the project-independent mirror. `null`
	 *  when no registered skill's `ships_with.hooks` names this hook. */
	shippedBy: { skill: string } | null;
	activation: CompanionActivation | undefined;
	/** Wave 4c unit 4 — opens the shared "Ship with…" flow, seeded with this
	 *  hook. `undefined` when no eligible skill could ever take it (§2.3):
	 *  the row then renders neither the interactive tag nor the ghost
	 *  button. */
	onShipWith?: () => void;
}) {
	const health = hookHealth(findings, hook.name);
	const extraTools = Math.max(0, hook.tools.length - TOOLS_SHOWN);
	// `action` is the CLI's discriminator; fall back to the script block so a row
	// still reads honestly against an older `hook list --json` payload.
	const action: HookAction =
		hook.action ?? (hook.script ? (`script:${hook.script.source}` as HookAction) : "command");
	return (
		<div
			/* a11y-ok: tabIndex + aria-selected arrive via {...itemProps} (useListNav roving tabIndex) */
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
					<HookAttachChip hook={hook} />
					{shippedBy ? (
						<>
							<CompanionTag
								word="shipped by"
								skill={shippedBy.skill}
								onClick={onShipWith}
								actionLabel="Ship with…"
							/>
							<span
								className="text-dim hook-activation"
								data-testid="hook-activation"
							>
								{activationWords(activation, shippedBy.skill)}
							</span>
						</>
					) : (
						onShipWith && (
							<Button
								variant="ghost"
								size="sm"
								icon="skill"
								data-testid="ship-with-open"
								onClick={(e) => {
									e.stopPropagation();
									onShipWith();
								}}
							>
								Ship with…
							</Button>
						)
					)}
					<HookHealthBadge health={health} />
				</div>
				{hook.description && (
					<div className="hook-row-desc text-dim">{hook.description}</div>
				)}
				<div
					className="hook-row-runs text-mono"
					title={
						hook.provenance === "builtin" && hook.baked_command
							? hook.baked_command
							: hookRunsLine(hook)
					}
				>
					{hookRunsLine(hook)}
				</div>
			</div>

			<div className="hook-row-matchers">
				<Tag size="sm" kind="outline" className="hook-event">
					<span className="text-mono">{hook.event || "—"}</span>
				</Tag>
				{action !== "command" && (
					<Tag size="sm" className="hook-action-tag">
						<span
							className="text-mono"
							title={`runs a ${action.replace("script:", "")} script`}
						>
							{action}
						</span>
					</Tag>
				)}
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

/**
 * Attach state — the other fact a row was missing (hooks-screen-polish Wave A).
 * Global wins outright: a hook attached globally also runs on every project,
 * so listing projects alongside it would be redundant at best and misleading
 * (implying it does NOT run elsewhere) at worst.
 */
function HookAttachChip({ hook }: { hook: HookRow }) {
	if (hook.attached_global) {
		return (
			<Tag size="sm" kind="outline" className="hook-attach">
				<span title="Attached everywhere (hooks_global)">global</span>
			</Tag>
		);
	}
	if (hook.attached_projects.length > 0) {
		const n = hook.attached_projects.length;
		return (
			<Tag size="sm" kind="outline" className="hook-attach">
				<span title={hook.attached_projects.join(", ")}>
					{n} project{n === 1 ? "" : "s"}
				</span>
			</Tag>
		);
	}
	return (
		<span
			className="text-dim hook-unattached"
			title="Attached nowhere — it never runs"
		>
			unattached
		</span>
	);
}

/** Doctor health — nothing renders while the hook is clean; a healthy hook
 *  should not compete for attention with the rows that actually need it. */
function HookHealthBadge({ health }: { health: HookHealth }) {
	if (health.worst === null) return null;
	const title = health.items.map((f) => f.detail).join("\n");
	return (
		<StatusBadge
			channel={hookHealthChannel(health.worst)}
			shape="pill"
			icon={health.worst === "info" ? "info" : "warning"}
			title={title}
			className="hook-health-badge"
		>
			{hookHealthLabel(health)}
		</StatusBadge>
	);
}
