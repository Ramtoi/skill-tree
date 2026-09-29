import { bundleSections } from "@/lib/bundlePlaybook";
import {
	useCallback, useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { Tag } from "@/components/Tag";
import { Chip } from "@/components/Chips";
import { Icon } from "@/components/Icon";
import { Spinner } from "@/components/loading/Spinner";
import { ScreenHeader } from "@/components/ScreenHeader";
import type { OverflowMenuItem } from "@/components/OverflowMenu";
import { EmptyState } from "@/components/EmptyState";
import { Popover } from "@/components/Popover";
import { EquipPicker, type EquipTarget } from "@/components/EquipPicker";
import { IconPicker } from "@/components/IconPicker";
import { ConfirmDialog } from "@/components/Modal";
import type { InlineNameHandle } from "@/components/InlineName";
import { bundleColor } from "@/components/bundleColors";
import { useBundleMembership } from "@/hooks/useBundleMembership";
import { useBundleScope } from "@/hooks/useBundleScope";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { useBundleProjectEquip } from "@/hooks/useEquip";
import { buildBundleProjectTargets, buildBundleSkillTargets } from "@/hooks/useEquipTargets";
import {
	backReturnOptions,
	fromNav,
	readBackTarget,
	useBackTarget,
	type BackTarget,
} from "@/lib/backTarget";
import { runHubCmd } from "@/lib/hubCmd";
import { getBundleScope, viaBundles } from "@/lib/resolveActiveSkills";
import { deriveSources, getSourceView, sourceAccent } from "@/lib/skillSource";
import { FILTER_THRESHOLD } from "@/lib/navRules";
import { plural } from "@/lib/plural";
import {
	bundleDeleteLanded,
	bundleWriteLanded,
	errText,
	runRegistryWrite,
	showBundleWarnings,
	type BundleCmdPayload,
	type BundleDeletePayload,
} from "@/lib/hubWrite";
import type { Bundle, Registry, SourceView } from "@/types";
import { BundleName } from "./BundleName";
import { BundleAddSkillsButton } from "./BundleAddSkillsButton";

const APPLIED_TO_POPOVER_WIDTH = 340;
const ICON_POPOVER_WIDTH = 260;

/** Writes one scalar bundle field (`description` or `icon`) as one merged
 *  `--<field>=` token. Optimistic edit + rollback of ONLY this bundle's
 *  slice of the registry (never the whole snapshot — see finding #5): a
 *  concurrent optimistic edit elsewhere in the registry (an Applied-to
 *  toggle, another bundle's write) must survive this write's own failure.
 *  Callers route this through `membership.enqueue` (G4) so it can never
 *  race a membership write for the same bundle. */
async function commitBundleField(
	queryClient: QueryClient,
	toast: ReturnType<typeof useToast>,
	bundleName: string,
	field: "description" | "icon",
	value: string,
): Promise<void> {
	const prev = queryClient.getQueryData<Registry>(qk.registry());
	const b = prev?.bundles[bundleName];
	if (prev && b) {
		queryClient.setQueryData<Registry>(qk.registry(), {
			...prev,
			bundles: { ...prev.bundles, [bundleName]: { ...b, [field]: value } },
		});
	}
	try {
		const { payload, warning } = await runRegistryWrite<BundleCmdPayload>(
			["bundle", "update", bundleName, `--${field}=${value}`, "--json"],
			bundleWriteLanded,
		);
		await invalidateRegistry(queryClient);
		showBundleWarnings(toast, payload);
		if (warning) toast.info("Sync reported findings", warning);
	} catch (err) {
		if (b) {
			queryClient.setQueryData<Registry>(qk.registry(), (cur) =>
				cur ? { ...cur, bundles: { ...cur.bundles, [bundleName]: b } } : cur,
			);
		}
		toast.error("Couldn't update bundle", errText(err));
		throw err;
	}
}

export interface BundleLensState {
	enqueueWrite: (write: () => Promise<void>) => Promise<void>;
	bundleName: string;
	bundle: Bundle;
	registry: Registry;
	/** `bundle.skills`, filtered to registry-known names, order preserved. */
	memberNames: string[];
	/** Names `bundle.skills` carries that the registry no longer knows. */
	missingNames: string[];
	isGlobal: boolean;
	scopePending: boolean;
	scopeTarget: boolean | null;
	scopeLocked: boolean;
	onGlobalToggle: (next: boolean) => void;
	isLinked: boolean;
	linkedSourceView: SourceView | null;
	sourceName: string | undefined;
	color: string;
	back: BackTarget;
	/** A real referrer (`fromNav`) exists — a project chip, or a Library
	 *  search result. Drives `BundleHeader`'s explicit back arrow (same
	 *  contract as `SkillEditor`); `false` shows the identity glyph instead. */
	hasReferrer: boolean;
	navigate: ReturnType<typeof useNavigate>;

	// Name
	renameBundle: (next: string) => Promise<void>;
	// Description
	commitDescription: (text: string) => Promise<void>;
	// Icon
	changeIcon: (icon: string) => Promise<void>;

	// Membership
	addSkillsTargets: EquipTarget[];
	onAddSkillsToggle: (target: EquipTarget, next: "on" | "off") => Promise<void>;
	addCreatedSkill: (name: string) => Promise<void>;
	removeSkill: (name: string) => void;
	removeMissing: () => void;

	// Applied to
	appliedCount: number;
	appliedTargets: EquipTarget[];
	onAppliedToggle: (target: EquipTarget, next: "on" | "off") => Promise<void>;

	// Overflow verbs
	duplicateBundle: () => void;
	showDetach: boolean;
	openDetach: () => void;
	closeDetach: () => void;
	detaching: boolean;
	detachSource: () => void;
	showDelete: boolean;
	openDelete: () => void;
	closeDelete: () => void;
	deleting: boolean;
	deleteBundle: () => void;
	appliedProjects: string[];
	deactivations: Array<{ project: string; skill: string }>;
	deactivatingSkills: Set<string>;
}

/**
 * Everything the Library's bundle mode needs — data, derived state and every
 * write — for ONE bundle. Returns `undefined` when `bundleName` is absent
 * (plain library) or the registry has no such bundle (the caller renders
 * `BundleNotFoundHeader` instead and never mounts the rest of bundle mode).
 */
export function useBundleLens(
	bundleName: string | undefined,
	registry: Registry,
): BundleLensState | undefined {
	const navigate = useNavigate();
	const toast = useToast();
	// Context-resolved (see `useBundleMembership`'s matching comment): the
	// module-level singleton only agrees with what's on screen in production
	// (main.tsx wraps `<App>` with it) — a test's own `QueryClient` needs the
	// one THIS render tree was actually given.
	const queryClient = useQueryClient();
	const membership = useBundleMembership(bundleName ?? "");
	const onAppliedToggleRaw = useBundleProjectEquip(bundleName ?? "");
	const undoableAction = useUndoableAction();
	// A bundle opens from the library or a project's applied-bundle chips; the
	// crumb trail names whichever it was, falling back to "Library" with no
	// real referrer (`hasReferrer` below gates the header's own back arrow).
	const location = useLocation();
	const back = useBackTarget({
		label: "Library",
		path: "/",
		crumbs: ["library", "bundles"],
	});
	const hasReferrer = !!readBackTarget(location.state);
	const [showDetach, setShowDetach] = useState(false);
	const [showDelete, setShowDelete] = useState(false);
	const [detaching, setDetaching] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const renameBusyRef = useRef(false);
	const [renamePending, setRenamePending] = useState(false);
	const scope = useBundleScope(bundleName, membership.enqueue, () => renameBusyRef.current || detaching || deleting);

	const bundle = bundleName ? registry.bundles[bundleName] : undefined;

	const registryNames = useMemo(
		() => new Set(Object.keys(registry.skills ?? {})),
		[registry.skills],
	);
	const memberNames = useMemo(
		() => (bundle?.skills ?? []).filter((s) => registryNames.has(s)),
		[bundle, registryNames],
	);
	const missingNames = useMemo(
		() => (bundle?.skills ?? []).filter((s) => !registryNames.has(s)),
		[bundle, registryNames],
	);
	const isGlobal = getBundleScope(bundle) === "global";
	const isLinked = !!bundle?.source;
	const linkedSourceView = useMemo(
		() => (bundle?.source ? getSourceView(bundle.source, deriveSources(registry)) : null),
		[bundle?.source, registry],
	);
	const sourceName = linkedSourceView?.name ?? bundle?.source;

	const appliedProjects = useMemo(() => {
		if (!bundleName) return [];
		return Object.entries(registry.projects ?? {})
			.filter(([, p]) => p.bundles?.includes(bundleName))
			.map(([n]) => n);
	}, [registry, bundleName]);

	const deactivations = useMemo(() => {
		if (!bundleName) return [] as Array<{ project: string; skill: string }>;
		const globallyProvided = new Set<string>();
		for (const b of Object.values(registry.bundles ?? {})) {
			if (getBundleScope(b) === "global") {
				(b.skills ?? []).forEach((s) => globallyProvided.add(s));
			}
		}
		const out: Array<{ project: string; skill: string }> = [];
		for (const p of appliedProjects) {
			const proj = registry.projects[p];
			for (const s of memberNames) {
				const direct = proj.enabled?.includes(s);
				const otherBundle = viaBundles(s, proj, registry).some((bn) => bn !== bundleName);
				if (!direct && !otherBundle && !globallyProvided.has(s)) {
					out.push({ project: p, skill: s });
				}
			}
		}
		return out;
	}, [registry, bundleName, appliedProjects, memberNames]);
	const deactivatingSkills = useMemo(
		() => new Set(deactivations.map((d) => d.skill)),
		[deactivations],
	);

	const appliedCount = isGlobal
		? Object.keys(registry.projects ?? {}).length
		: appliedProjects.length;

	const addSkillsTargets = useMemo(
		() => buildBundleSkillTargets(memberNames, registry),
		[memberNames, registry],
	);
	const appliedTargets = useMemo(
		() => (isGlobal || !bundleName ? [] : buildBundleProjectTargets(bundleName, registry)),
		[isGlobal, bundleName, registry],
	);

	// Rename, like description/icon, goes through the per-bundle write queue
	// (G4) so it can never land out of order against a queued membership
	// write for the same (old) name. It is also undoable (D4): the header
	// field reopens on failure via `InlineName`'s own `onSave` rejection, so
	// this only needs to report the error and rethrow.
	const renameBundle = useCallback(
		(next: string) => {
			if (!bundleName) return Promise.resolve();
			const previous = bundleName;
			renameBusyRef.current = true;
			setRenamePending(true);
			return membership.enqueue(async () => {
				try {
					await undoableAction({
						do: async () => {
							await runHubCmd(["bundle", "rename", previous, next]);
							await invalidateRegistry(queryClient);
							navigate(`/bundle/${encodeURIComponent(next)}`, { replace: true, state: location.state });
						},
						undo: async () => {
							await runHubCmd(["bundle", "rename", next, previous]);
							await invalidateRegistry(queryClient);
							navigate(`/bundle/${encodeURIComponent(previous)}`, { replace: true, state: location.state });
						},
						label: `Renamed ${previous} to ${next}`,
						// Rename and undo refresh before navigation so the route can
						// never point at a bundle the cache does not know yet.
						invalidate: [],
					});
				} catch (err) {
					toast.error("Couldn't rename bundle", errText(err));
					throw err;
				} finally {
					renameBusyRef.current = false;
					setRenamePending(false);
				}
			});
		},
		[bundleName, membership, undoableAction, navigate, toast, location.state, queryClient],
	);

	// Description and icon writes route through the SAME per-bundle write
	// queue every membership write uses (`membership.enqueue`, G4) — without
	// it these could land out of order against a membership write for the
	// same bundle (finding #4).
	const commitDescription = useCallback(
		(text: string) => {
			if (!bundleName) return Promise.resolve();
			return membership.enqueue(() =>
				commitBundleField(queryClient, toast, bundleName, "description", text),
			);
		},
		[bundleName, toast, queryClient, membership],
	);

	const changeIcon = useCallback(
		(icon: string) => {
			if (!bundleName) return Promise.resolve();
			return membership.enqueue(() =>
				commitBundleField(queryClient, toast, bundleName, "icon", icon),
			);
		},
		[bundleName, toast, queryClient, membership],
	);

	const removeSkill = useCallback(
		(name: string) => {
			if (isLinked || !bundleName) return;
			const index = memberNames.indexOf(name);
			const label = isGlobal
				? `Removed ${name} from ${bundleName} — every project`
				: `Removed ${name} from ${bundleName}`;
			void undoableAction({
				do: () => membership.remove(name),
				undo: () => membership.insert(name, index),
				label,
				invalidate: [qk.registry()],
			}).catch(() => {
				/* the hook's own toast already reported the failure */
			});
		},
		[isLinked, bundleName, memberNames, isGlobal, undoableAction, membership],
	);

	const removeMissing = useCallback(() => {
		void membership.removeMissing().catch(() => {});
	}, [membership]);

	const duplicateBundle = useCallback(() => {
		if (!bundleName || !bundle) return;
		void (async () => {
			const copyName = `${bundleName}-copy`;
			try {
				const args = ["bundle", "new", copyName, "--skills", memberNames.join(",")];
				if (bundle.description) args.push(`--description=${bundle.description}`);
				if (bundle.icon) args.push(`--icon=${bundle.icon}`);
				if (bundle.playbook) args.push("--playbook", JSON.stringify(bundleSections({ ...bundle, skills: memberNames })));
				args.push("--json");
				const { payload, warning } = await runRegistryWrite<BundleCmdPayload>(
					args,
					bundleWriteLanded,
				);
				await invalidateRegistry(queryClient);
				toast.success(`Duplicated to "${copyName}"`);
				showBundleWarnings(toast, payload);
				if (warning) toast.info("Sync reported findings", warning);
				navigate(`/bundle/${encodeURIComponent(copyName)}`, fromNav(back));
			} catch (err) {
				toast.error("Couldn't duplicate bundle", errText(err));
			}
		})();
	}, [bundleName, bundle, memberNames, toast, navigate, back, queryClient]);

	const detachSource = useCallback(() => {
		if (!bundleName || scope.busyRef.current) return;
		setDetaching(true);
		// Same per-bundle write queue as every membership write (G4) — a
		// detach racing a membership write for the same bundle is exactly the
		// out-of-order write finding #4 flags.
		void membership
			.enqueue(async () => {
				const { payload, warning } = await runRegistryWrite<BundleCmdPayload>(
					["bundle", "update", bundleName, "--detach-source", "--json"],
					bundleWriteLanded,
				);
				await invalidateRegistry(queryClient);
				toast.success(
					`"${bundleName}" no longer follows ${sourceName}`,
					"Its skills are yours to edit.",
				);
				showBundleWarnings(toast, payload);
				if (warning) toast.info("Sync reported findings", warning);
				setShowDetach(false);
			})
			.catch((err) => {
				toast.error("Couldn't detach bundle", errText(err));
			})
			.finally(() => {
				setDetaching(false);
			});
	}, [bundleName, sourceName, toast, queryClient, membership, scope.busyRef]);

	const deleteBundle = useCallback(() => {
		if (!bundleName || scope.busyRef.current) return;
		void (async () => {
			setDeleting(true);
			try {
				const { warning } = await runRegistryWrite<BundleDeletePayload>(
					["bundle", "delete", bundleName, "--json"],
					bundleDeleteLanded,
				);
				await invalidateRegistry(queryClient);
				toast.success(`Deleted bundle "${bundleName}"`);
				if (warning) toast.info("Sync reported findings", warning);
				navigate(back.path, backReturnOptions(back));
			} catch (err) {
				setDeleting(false);
				toast.error("Couldn't delete bundle", errText(err));
			}
		})();
	}, [bundleName, toast, navigate, back, queryClient, scope.busyRef]);

	if (!bundleName || !bundle) return undefined;

	return {
		bundleName,
		enqueueWrite: membership.enqueue,
		bundle,
		registry,
		memberNames,
		missingNames,
		isGlobal,
		scopePending: scope.pending,
		scopeTarget: scope.target,
		scopeLocked: scope.busy || detaching || deleting || renamePending,
		onGlobalToggle: scope.toggle,
		isLinked,
		linkedSourceView,
		sourceName,
		color: bundleColor(bundleName),
		back,
		hasReferrer,
		navigate,
		renameBundle,
		commitDescription,
		changeIcon,
		addSkillsTargets,
		onAddSkillsToggle: membership.toggle,
		addCreatedSkill: membership.add,
		removeSkill,
		removeMissing,
		appliedCount,
		appliedTargets,
		onAppliedToggle: (target, next) => {
			if (scope.busyRef.current || renameBusyRef.current) return Promise.resolve();
			return membership.enqueue(() => onAppliedToggleRaw(target, next));
		},
		duplicateBundle,
		showDetach,
		openDetach: () => setShowDetach(true),
		closeDetach: () => setShowDetach(false),
		detaching,
		detachSource,
		showDelete,
		openDelete: () => setShowDelete(true),
		closeDelete: () => setShowDelete(false),
		deleting,
		deleteBundle,
		appliedProjects,
		deactivations,
		deactivatingSkills,
	};
}

/** Header + EmptyState for a `/bundle/:name` route the registry doesn't
 *  know — same chrome, same way back, as any other missing-entity screen. */
export function BundleNotFoundHeader({
	bundleName,
	navigate,
}: {
	bundleName: string;
	navigate: ReturnType<typeof useNavigate>;
}) {
	const back = useBackTarget({
		label: "Library",
		path: "/",
		crumbs: ["library", "bundles"],
	});
	return (
		<>
			<ScreenHeader
				back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
				nameMono={bundleName}
				crumbs={[...(back.crumbs ?? [back.label]), bundleName]}
			/>
			<div className="main-body">
				<EmptyState
					icon="bundle"
					title={`Bundle "${bundleName}" not found`}
					description="Pick another bundle from the library."
					action={
						<BackButton onClick={() => navigate(back.path, backReturnOptions(back))}>
							Back to {back.label}
						</BackButton>
					}
				/>
			</div>
		</>
	);
}

/** The emoji identity chip. Rendered in the header's `leading` slot —
 *  hidden automatically whenever `ScreenHeader` derives an in-place back
 *  arrow instead (back beats leading). Its icon-change `Popover` is owned
 *  by `BundleHeader`, not this button, so the overflow menu's "Change
 *  icon…" item can open it even when this button isn't mounted at all —
 *  see `BundleHeader`'s `iconAnchorRef` doc comment. */
function BundleGlyphButton({
	lens,
	open,
	onToggle,
	anchorRef,
}: {
	lens: BundleLensState;
	open: boolean;
	onToggle: () => void;
	anchorRef: RefObject<HTMLButtonElement | null>;
}) {
	return (
		<button
			ref={anchorRef}
			type="button"
			className="header-bundle-glyph live-glint"
			data-live="true"
			style={{ "--bundle-accent": lens.color } as CSSProperties}
			title="Change icon…"
			aria-label="Change icon"
			aria-haspopup="dialog"
			aria-expanded={open}
			onClick={onToggle}
		>
			{lens.bundle.icon || "📦"}
		</button>
	);
}

/** "Applied to" — a project-equip chip for a project-specific bundle, or a
 *  dim "auto-applied everywhere" tag for a global one (the CLI refuses
 *  `--project` on a global bundle, so no picker is offered for one). */
function AppliedToControl({ lens }: { lens: BundleLensState }) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (lens.scopeLocked) setOpen(false);
	}, [lens.scopeLocked]);
	if (lens.isGlobal) {
		return (
			<Tag className="tag-sentence" color="var(--fg-mute)">
				auto-applied everywhere
			</Tag>
		);
	}
	return (
		<>
			<Chip
				ref={anchorRef}
				icon="project"
				count={lens.appliedCount}
				pressed={open}
				disabled={lens.scopeLocked}
				dataTestid="bundle-applied-chip"
				title={`Applied to ${lens.appliedCount} ${plural(lens.appliedCount, "project")}`}
				onClick={() => setOpen((o) => !o)}
			>
				Applied to
			</Chip>
			<Popover
				open={open && !lens.scopeLocked}
				onClose={() => setOpen(false)}
				anchorRef={anchorRef}
				label={`${lens.bundleName} — applied to`}
				width={APPLIED_TO_POPOVER_WIDTH}
			>
				<EquipPicker
					variant="inline"
					filterThreshold={FILTER_THRESHOLD}
					subject={{ kind: "bundle", name: lens.bundleName }}
					targets={lens.appliedTargets}
					onToggle={lens.onAppliedToggle}
					listLabel="Projects"
					searchPlaceholder="Filter projects…"
					emptyLabel="No projects registered."
				/>
			</Popover>
		</>
	);
}

/** The band's description input (row 2, left). Dirty tracking follows an
 *  explicit `onChange` flag (never a value compare — a saved description
 *  with a newline compares unequal to itself after an `<input>` flattens it)
 *  and hydrates from the registry only while unfocused and clean, so a
 *  registry refetch mid-type can never clobber what the user is typing. */
function BundleDescriptionInput({ lens }: { lens: BundleLensState }) {
	const saved = lens.bundle.description ?? "";
	const [draft, setDraft] = useState(saved);
	const [dirty, setDirty] = useState(false);
	const [focused, setFocused] = useState(false);
	// `.blur()` below dispatches its blur event SYNCHRONOUSLY, before React
	// commits the `setDirty(false)` a few lines above it — so `onBlur`'s own
	// closure would still read the stale `dirty === true` and re-commit the
	// very value Escape just reverted. A ref sidesteps the batching: it is
	// readable immediately, in the same tick, unlike state.
	const skipNextCommitRef = useRef(false);

	const value = focused || dirty ? draft : saved;

	function commitIfDirty() {
		if (!dirty) return;
		const text = draft;
		setDirty(false);
		if (text === saved) return;
		void lens.commitDescription(text).catch(() => {
			// Reverted by the hook's own optimistic rollback; nothing else to do.
		});
	}

	return (
		<input
			className="bundle-desc-input"
			value={value}
			placeholder="Add a description…"
			title={saved || "Click to edit"}
			aria-label="Bundle description"
			onFocus={() => {
				setFocused(true);
				setDraft(saved);
			}}
			onChange={(e) => {
				setDirty(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				setFocused(false);
				if (skipNextCommitRef.current) {
					skipNextCommitRef.current = false;
					return;
				}
				commitIfDirty();
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					(e.target as HTMLInputElement).blur();
				} else if (e.key === "Escape") {
					e.preventDefault();
					skipNextCommitRef.current = true;
					setDirty(false);
					setDraft(saved);
					(e.target as HTMLInputElement).blur();
				}
			}}
		/>
	);
}

export interface BundleHeaderProps {
	lens: BundleLensState;
	subheaderRight: ReactNode;
	subheaderFilters?: ReactNode;
}

/** Row 1 + row 2 (the band) for a bundle that exists, plus its Detach/Delete
 *  confirms. `subheaderRight` is the SAME GROUP scope/source + list/grid
 *  cluster the plain library renders — passed in so it is defined exactly
 *  once, never forked between modes. */
export function BundleHeader({ lens, subheaderRight, subheaderFilters }: BundleHeaderProps) {
	const nameRef = useRef<InlineNameHandle>(null);
	const crumbTokens = lens.back.crumbs ?? [lens.back.label];
	const [iconOpen, setIconOpen] = useState(false);
	const glyphAnchorRef = useRef<HTMLButtonElement | null>(null);
	// The icon `Popover` needs an anchor even when the identity glyph isn't
	// mounted at all — reached IN PLACE from another section, `ScreenHeader`
	// shows a back arrow instead of `leading` (back beats leading), so
	// `glyphAnchorRef.current` is null. Falling back to the overflow
	// trigger's own DOM node (findable by its stable testid; `ScreenHeader`
	// exposes no ref of its own for it) keeps "Change icon…" reachable from
	// the overflow either way (finding #1) — a getter, not a plain ref, so
	// each read re-checks which anchor actually exists right now.
	const iconAnchorRef = useMemo<RefObject<HTMLElement | null>>(
		() => ({
			get current() {
				return (
					glyphAnchorRef.current ??
					document.querySelector<HTMLElement>('.main-header [data-testid="overflow-trigger"]')
				);
			},
		}),
		[],
	);
	const overflow: OverflowMenuItem[] = [
		{
			icon: "edit",
			label: "Rename bundle…",
			restoreFocus: false,
			onClick: () => nameRef.current?.startEditing(),
		},
		{
			label: "Global",
			disabled: lens.scopeLocked && !lens.scopePending,
			switch: {
				checked: lens.scopeTarget ?? lens.isGlobal,
				busy: lens.scopePending,
				description: lens.isLinked ? "Source changes reach every project when global" : undefined,
				onChange: lens.onGlobalToggle,
			},
		},
		{
			icon: "edit",
			label: "Change icon…",
			onClick: () => setIconOpen(true),
		},
		...(lens.missingNames.length > 0
			? [
					{
						icon: "warning",
						label: "Remove missing skills",
						onClick: lens.removeMissing,
					},
				]
			: []),
		{ icon: "copy", label: "Duplicate bundle", onClick: lens.duplicateBundle },
		...(lens.isLinked
			? [{ icon: "link", label: "Detach from source…", disabled: lens.scopePending, onClick: lens.openDetach }]
			: []),
		{ divider: true },
		{
			icon: "trash",
			label: "Delete bundle…",
			disabled: lens.scopePending,
			danger: true,
			onClick: lens.openDelete,
		},
	];

	return (
		<>
			<ScreenHeader
				// A real referrer (project chip, or a Library search result, H1)
				// always earns an explicit back arrow, same as `SkillEditor` — the
				// glyph takes the column instead when there is none to return to.
				back={
					lens.hasReferrer
						? { label: lens.back.label, onClick: () => lens.navigate(lens.back.path, backReturnOptions(lens.back)) }
						: undefined
				}
				leading={
					<BundleGlyphButton
						lens={lens}
						open={iconOpen}
						onToggle={() => setIconOpen((o) => !o)}
						anchorRef={glyphAnchorRef}
					/>
				}
				nameMono={
					// The name edits where it is read, same as a project's header
					// (rare, cheap-to-reverse edit → an inline field + undo, not a
					// dialog).
					<BundleName
						editorRef={nameRef}
						name={lens.bundleName}
						bundles={lens.registry.bundles}
						onSave={lens.renameBundle}
					/>
				}
				meta={
					<>
						{lens.scopePending && (
							<span data-testid="bundle-scope-saving" role="status">
								<Tag className="tag-sentence" color="var(--fg-mute)">
									<Spinner size={12} /> Saving scope…
								</Tag>
							</span>
						)}
						<Tag className="tag-sentence" color="var(--fg-mute)">
							{lens.memberNames.length} {plural(lens.memberNames.length, "skill")}
						</Tag>
						{lens.missingNames.length > 0 && (
							<span
								data-testid="bundle-missing-tag"
								title={`Not in the library: ${lens.missingNames.join(", ")}`}
							>
								<Tag color="var(--amber)">{lens.missingNames.length} missing</Tag>
							</span>
						)}
						{lens.isLinked && (
							<span data-testid="bundle-linked-lock">
								<Tag color={sourceAccent(lens.bundle.source!)}>
									<span
										className="bundle-source-dot"
										style={
											{ "--dot-color": sourceAccent(lens.bundle.source!) } as CSSProperties
										}
									/>
									Follows <span className="text-mono">{lens.sourceName}</span>
								</Tag>
							</span>
						)}
						{!lens.isLinked && lens.isGlobal && (
							<Tag className="tag-sentence" color="var(--fg-mute)">
								global
							</Tag>
						)}
					</>
				}
				crumbs={[
					<button
						key="c0"
						type="button"
						className="crumb-link"
						// Distinct from the auto-derived back arrow's "Back to X" title
						// (both can be on screen at once — this is a second, always-
						// present way out, not a restatement of the first).
						title={`Go to ${lens.back.label}`}
						aria-label={`Go to ${lens.back.label}`}
						onClick={() => lens.navigate(lens.back.path, backReturnOptions(lens.back))}
					>
						{crumbTokens[0]}
					</button>,
					...crumbTokens.slice(1),
					lens.bundleName,
				]}
				secondary={<AppliedToControl lens={lens} />}
				primary={!lens.isLinked ? <BundleAddSkillsButton lens={lens} /> : undefined}
				overflow={overflow}
				subheader={{
					left: (
						<div className="library-bundle-band" data-testid="library-bundle-band">
							<BundleDescriptionInput lens={lens} />
							{subheaderFilters}
						</div>
					),
					right: subheaderRight,
				}}
			/>

			<Popover
				open={iconOpen}
				onClose={() => setIconOpen(false)}
				anchorRef={iconAnchorRef}
				label={`Change ${lens.bundleName}'s icon`}
				width={ICON_POPOVER_WIDTH}
			>
				<IconPicker
					value={lens.bundle.icon || "📦"}
					onChange={(icon) => {
						void lens.changeIcon(icon);
						setIconOpen(false);
					}}
				/>
			</Popover>

			<ConfirmDialog
				open={lens.showDetach}
				title={`Stop following ${lens.sourceName}?`}
				confirmLabel="Detach bundle"
				confirmIcon="link"
				busy={lens.detaching}
				onClose={lens.closeDetach}
				onConfirm={lens.detachSource}
				blastRadius={
					<div className="bundle-delete-blast">
						<p>
							<strong>{lens.memberNames.length}</strong>{" "}
							{lens.memberNames.length === 1 ? "skill stays" : "skills stay"} in this
							bundle — nothing is removed and no project changes.
						</p>
						<p className="ok">
							After detaching you can add and remove skills by hand. Syncing{" "}
							<span className="mono">{lens.sourceName}</span> will no longer touch this
							bundle.
						</p>
					</div>
				}
			/>

			<ConfirmDialog
				open={lens.showDelete}
				title={`Delete bundle "${lens.bundleName}"?`}
				tone="danger"
				confirmLabel="Delete bundle"
				confirmIcon="trash"
				busy={lens.deleting}
				onClose={lens.closeDelete}
				onConfirm={lens.deleteBundle}
				blastRadius={
					<div className="bundle-delete-blast">
						{lens.appliedProjects.length === 0 ? (
							<p>
								This bundle is not applied to any project. Deleting it removes the bundle
								definition only.
							</p>
						) : (
							<>
								<p>
									Applied to{" "}
									<strong>
										{lens.appliedProjects.length}{" "}
										{lens.appliedProjects.length === 1 ? "project" : "projects"}
									</strong>
									: <span className="mono">{lens.appliedProjects.join(", ")}</span>
								</p>
								{lens.deactivations.length === 0 ? (
									<p className="ok">
										No skills will deactivate — every skill in this bundle stays active via
										a direct equip or another bundle.
									</p>
								) : (
									<>
										<p className="warn">
											<strong>{lens.deactivations.length}</strong> skill{" "}
											{lens.deactivations.length === 1 ? "activation" : "activations"} will
											deactivate ({lens.deactivatingSkills.size} distinct{" "}
											{lens.deactivatingSkills.size === 1 ? "skill" : "skills"}):
										</p>
										<ul className="mono">
											{lens.appliedProjects.map((p) => {
												const skills = lens.deactivations
													.filter((d) => d.project === p)
													.map((d) => d.skill);
												if (skills.length === 0) return null;
												return (
													<li key={p}>
														{p} → {skills.join(", ")}
													</li>
												);
											})}
										</ul>
									</>
								)}
							</>
						)}
					</div>
				}
			/>
		</>
	);
}

/** A row's "remove from bundle" action, or the linked-lock glyph in its
 *  place — the two are mutually exclusive per skill, per SkillRow's
 *  `extraActions` slot. */
export function BundleRowAction({
	lens,
	name,
}: {
	lens: BundleLensState;
	name: string;
}) {
	if (lens.isLinked) {
		return (
			<span className="card-lock" title={`Managed by ${lens.sourceName}`}>
				<Icon name="link" size={12} />
			</span>
		);
	}
	return (
		<Button
			variant="ghost"
			size="sm"
			icon="x"
			title={`Remove from ${lens.bundleName}`}
			aria-label={`Remove ${name} from ${lens.bundleName}`}
			onClick={(e) => {
				e.stopPropagation();
				lens.removeSkill(name);
			}}
		/>
	);
}
