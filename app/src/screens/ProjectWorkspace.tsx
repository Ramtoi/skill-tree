import { useFeedbackTab } from "@/hooks/useFeedbackTab";
import { loadoutViewportSnapshot } from "@/hooks/useProjectLoadoutReturn";
import { readLoadoutReturn } from "@/lib/projectLoadoutReturn";
import { removeProjectLoadoutOrder } from "@/hooks/useProjectLoadoutOrder";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useListNav } from "@/hooks/useListNav";
import { useParams, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { attemptNavigation } from "@/lib/navGuard";
import { runHubCmd as sharedRunHubCmd } from "@/lib/hubCmd";
// `String(err)` on a HubCommandError renders "HubCommandError: <headline>" —
// the class name is noise in a toast. `errorDetail` yields the headline alone.
import { errorDetail } from "@/lib/cliOutput";
import { parseCmdPayload } from "@/lib/hubWrite";
import { removalSentence, type DisablePayload } from "@/lib/companions";
import { useCompanionGate, equipErrorToast } from "@/hooks/useCompanionGate";
import { useToast } from "@/components/Toast";
import { useUndoableAction, UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";
import { useAppStore } from "@/store";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import {
	bundleProvidedSkills,
	getBundleScope,
	resolveActiveSkills,
} from "@/lib/resolveActiveSkills";
import { projectFreshness, projectRecord } from "@/lib/syncFreshness";
import { projectMissingRefs } from "@/lib/missingRefs";
import { useHarnesses } from "@/hooks/useHarnesses";
import { Button } from "@/components/Button";
import type { OverrideChoice } from "@/lib/invocation";
import { ScreenHeader } from "@/components/ScreenHeader";
import { parseProjectTab, type ProjectArea } from "@/lib/projectViews";
import { ProjectAreaStrip } from "@/screens/project/ProjectAreaStrip";
import { type BundleChipAddOption } from "@/components/BundleChip";
import { EmptyState } from "@/components/EmptyState";
import { bundleColor } from "@/components/bundleColors";
import { EditProjectPathDialog } from "@/components/EditProjectPathDialog";
import { RemoveProjectDialog } from "@/components/RemoveProjectDialog";
import { ProjectRepositoryDialog } from "@/components/ProjectRepositoryDialog";
import { AgentDocsView } from "@/components/AgentDocsView";
import { ProjectPermissionsTab } from "@/components/ProjectPermissionsTab";
import type { ProjectSkillCandidate } from "@/components/ProjectLocalSkills";
import type { SkillScope } from "@/types";
import { ProjectSubagentsTab } from "@/screens/project/ProjectSubagentsTab";
import { ProjectLoadoutView } from "@/screens/project/ProjectLoadoutView";
import { ProjectUsageTab } from "@/screens/project/ProjectUsageTab";
import { ProjectReviewProvider } from "@/screens/project/ProjectReviewProvider";
import { useClearUsageLoadoutDelta } from "@/store/usageLoadoutDelta";
import { useProjectLoadoutFeedback } from "@/hooks/useProjectLoadoutFeedback";
import { buildRefsGuardrailDeps, equipSkillRefsOnly } from "@/hooks/useEquip";

type DropZone = "equipped" | "avail" | null;

export type EquipSort = "newest" | "name";
export type EquipStatus = "pending" | "success" | "error";

export function ProjectWorkspace() {
	const { name: projectName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { data: registry, isLoading } = useRegistry();
	const { data: syncEnvelope } = useSyncReport();
	const harnesses = useHarnesses();
	const installedHarnessIds = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);
	const toast = useToast();
	const runUndoable = useUndoableAction();
	const feedback = useProjectLoadoutFeedback(projectName);
	const gate = useCompanionGate();
	const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);
	const clearUsageLoadoutDelta = useClearUsageLoadoutDelta(projectName ?? "");
	const clearDeltaRef = useRef(clearUsageLoadoutDelta);
	clearDeltaRef.current = clearUsageLoadoutDelta;
	useEffect(() => () => clearDeltaRef.current(), [projectName]);
	// One sync implementation app-wide (`useRunSync`) — see its docstring.
	const runSync = useRunSync();
	const syncing = useSyncing();

	// Deep-link into an area via `?tab=` (palette "Open project…" verb).
	const initialTab = searchParams.get("tab");
	const [view, setView] = useState<ProjectArea>(
		() => parseProjectTab(initialTab) ?? "loadout",
	);
	useFeedbackTab("project", view);
	const [dragOver, setDragOver] = useState<DropZone>(null);
	const [availQuery, setAvailQuery] = useState(() =>
		readLoadoutReturn(location.state, projectName ?? "").availableQuery,
	);
	const [expandedAvailable, setExpandedAvailable] = useState<Set<string>>(
		() => new Set(),
	);
	const [equipStatus, setEquipStatus] = useState<Record<string, EquipStatus>>(
		{},
	);
	const [removingBundles, setRemovingBundles] = useState<Set<string>>(() => new Set());
	const [showEditPath, setShowEditPath] = useState(false);
	const [showRepository, setShowRepository] = useState(false);
	const [showRemove, setShowRemove] = useState(false);
	// Per-skill success-fade timers; cleared on unmount so a late fire can't
	// setState after teardown.
	const equipFadeTimers = useRef<number[]>([]);
	const mounted = useRef(false);
	useEffect(() => {
		const timers = equipFadeTimers.current;
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const t of timers) window.clearTimeout(t);
		};
	}, []);

	// Record only a project the registry actually knows. A bad deep link or a
	// just-removed project still routes here, and a Recent chip pointing at it
	// would be a permanent dead end in the strip.
	const projectExists = !!(projectName && registry?.projects?.[projectName]);
	useEffect(() => {
		if (projectExists)
			addRecentlyVisited({ type: "project", name: projectName });
	}, [projectExists, projectName, addRecentlyVisited]);

	// Follow a later `?tab=` change while the component stays mounted.
	useEffect(() => {
		setView(parseProjectTab(initialTab) ?? "loadout");
	}, [initialTab, projectName]);

	const localAttached = !!projectName && !!registry?.projects?.[projectName]
		&& !registry.projects[projectName].path_unresolved;
	const projPath = projectName && localAttached
		? registry?.projects?.[projectName]?.path
		: undefined;
	const envPath = projPath ? `${projPath}/.env` : "";
	const { data: envExists } = useQuery({
		queryKey: qk.envExists(projPath ?? ""),
		queryFn: () => invoke<boolean>("path_exists", { path: envPath }),
		enabled: !!projPath,
	});

	const { data: localCandidates } = useQuery({
		queryKey: qk.projectCandidates(projectName ?? ""),
		queryFn: () =>
			invoke<ProjectSkillCandidate[]>("project_scan_candidates", {
				name: projectName,
			}),
		enabled: !!projectName && localAttached,
	});

	// --- derived (HOISTED above the loading/not-found guards) ----------------
	// Every hook below (`useMemo` ×2, `useListNav`) must run on EVERY render so
	// hook order stays stable while the registry query is still deferred — the
	// early returns come AFTER these. Inputs guard for an absent project/registry
	// and fall back to empty collections; once both resolve, they hold real data
	// (the render that reaches the JSX below is always past both guards).
	const projGuard = projectName
		? registry?.projects?.[projectName]
		: undefined;

	const equipped =
		projGuard && registry ? resolveActiveSkills(projGuard, registry) : [];
	const equippedSet = new Set(equipped);

	// Shared, global-bundle-aware provenance selectors (design D1) — no local
	// re-derivation, so a global-bundle skill is never mislabelled as DIRECT.
	const bundleProvidedSet =
		projGuard && registry
			? bundleProvidedSkills(projGuard, registry)
			: new Set<string>();

	// Globally-scoped bundles auto-apply to every project — surfaced as a
	// read-only cluster, never folded into the removable applied count.
	const globalBundles = registry
		? Object.entries(registry.bundles).filter(
				([, b]) => getBundleScope(b) === "global",
			)
		: [];

	const freshness = projectFreshness(projectName ?? "", syncEnvelope, projGuard);

	// M8 per-project banner: the sync report's `affinity_skips` is the evidence
	// (what the last sync actually skipped for want of a matching harness). It is
	// the source of truth when present; the per-card badge is its predictive twin.
	const affinitySkips =
		projectRecord(projectName ?? "", syncEnvelope)?.affinity_skips ?? [];

	// Evidence-based: the last sync report's `missing_refs` finding (no
	// client-side predictive twin — the rule needs a skill's body text, which
	// the registry does not carry). Threaded through as a resolved list so
	// neither the Loadout view nor the grid ever sees the envelope itself.
	const missingRefs = projectMissingRefs(projectName ?? "", syncEnvelope);

	// A16: the last sync's I7 companions reconcile record for this project —
	// evidence for the Loadout's `COMPANIONS_PENDING` banner, read the same
	// way `affinitySkips`/`missingRefs` are above (the Loadout view never
	// touches the envelope itself).
	const companionsReconcile = projectRecord(
		projectName ?? "",
		syncEnvelope,
	)?.companions;

	const availableBundles: BundleChipAddOption[] =
		registry && projGuard
			? Object.entries(registry.bundles)
					.filter(
						([n, b]) =>
							!projGuard.bundles.includes(n) &&
							getBundleScope(b) !== "global",
					)
					.map(([n, b]) => ({
						name: n,
						icon: b.icon,
						color: bundleColor(n),
						count: b.skills?.length ?? 0,
					}))
			: [];

	const unequippedNames = registry
		? Object.keys(registry.skills).filter((name) => !equippedSet.has(name))
		: [];

	const filteredUnequipped = useMemo(() => {
		const q = availQuery.trim().toLowerCase();
		if (!q) return unequippedNames;
		return unequippedNames.filter((name) => {
			const s = registry?.skills[name];
			return (
				name.toLowerCase().includes(q) ||
				(s?.description ?? "").toLowerCase().includes(q)
			);
		});
	}, [availQuery, unequippedNames, registry?.skills]);

	function toggleAvailableDetails(skillName: string) {
		setExpandedAvailable((current) => {
			const next = new Set(current);
			if (next.has(skillName)) next.delete(skillName);
			else next.add(skillName);
			return next;
		});
	}

	const scopeGroups: { scope: SkillScope; label: string; names: string[] }[] = [
		{
			scope: "global",
			label: "GLOBAL",
			names: filteredUnequipped.filter(
				(n) => registry?.skills[n]?.scope === "global",
			),
		},
		{
			scope: "portable",
			label: "PORTABLE",
			names: filteredUnequipped.filter(
				(n) => registry?.skills[n]?.scope === "portable",
			),
		},
		{
			scope: "project-specific",
			label: "PROJECT",
			names: filteredUnequipped.filter(
				(n) => registry?.skills[n]?.scope === "project-specific",
			),
		},
	];

	// Roving keyboard nav for the Available list (B1-08) — mirrors SkillLibrary's
	// useListNav so the core equip job is keyboard-first on this surface too. The
	// keydown binds on the LIST CONTAINER (focus-scoped), so it never competes
	// with the window-level chord handler. Flat render order across scope groups
	// so j/k crosses group boundaries; both Enter and `e` equip the focused row.
	const flatAvail = scopeGroups.flatMap((g) => g.names);
	const availRowIndex = new Map(flatAvail.map((n, i) => [n, i] as const));
	const availNav = useListNav({
		count: flatAvail.length,
		onOpen: (i) => {
			const name = flatAvail[i];
			if (name) void enableSkill(name);
		},
		onSecondary: (i) => {
			const name = flatAvail[i];
			if (name) void enableSkill(name);
		},
		// ArrowRight/ArrowLeft reach the disclosure once its chevron is taken
		// out of the tab order by the roving wrapper (ResourceRow's tabIndex
		// contract — see hooks/useListNav.ts's doc comment).
		onToggleDetail: (i) => {
			const name = flatAvail[i];
			if (name) toggleAvailableDetails(name);
		},
	});

	if (isLoading) {
		// C4 — the identity column and the project name come from the route, so
		// they paint immediately; only the payload waits. A route placeholder
		// (`/project/__none__`) is not a name the user would recognise, so it
		// stays out of the title exactly as in the not-found branch below.
		const loadingSentinel = !projectName || /^__.*__$/.test(projectName);
		return (
			<>
				<ScreenHeader
					leading={<span className="project-dot" />}
					{...(loadingSentinel
						? { title: "Project" }
						: { nameMono: projectName })}
					crumbs={loadingSentinel ? ["projects"] : ["projects", projectName]}
				/>
				<div className="main-body">
					<EmptyState
						icon="bolt"
						title="Loading workspace"
						description="Loading project…"
					/>
				</div>
			</>
		);
	}

	if (!projectName || !registry?.projects?.[projectName]) {
		// A route placeholder (`/project/__none__`) is not a project the user
		// named — headlining it made the app look like it had lost something
		// that never existed. The name survives in the body only when it is a
		// real one the user could recognise.
		const isSentinel = !projectName || /^__.*__$/.test(projectName);
		return (
			<>
				{/* Every other screen carries a header; this one shipped without
				    one, so a broken deep link had no breadcrumb and no way back
				    except the single Add-project button. */}
				<ScreenHeader
					back={{ label: "Library", onClick: () => navigate("/") }}
					title={isSentinel ? "No project selected" : "Project not found"}
					subline="A project is the linking target hub writes your equipped skills into."
				/>
				<div className="main-body">
					<EmptyState
						icon="project"
						title="Register a project"
						description={
							isSentinel
								? "Register a project to equip skills and apply bundles to it."
								: `No project named "${projectName}" is registered. Add one to equip skills and apply bundles to it.`
						}
						action={
							<Button
								variant="primary"
								icon="plus"
								onClick={() => navigate("/?addProject=1")}
							>
								Add project
							</Button>
						}
					/>
				</div>
			</>
		);
	}

	const proj = registry.projects[projectName];

	// One compact navigator remains in the same place across project areas.
	const navigator = (
		<ProjectAreaStrip
			projectName={projectName}
			value={view}
			onChange={(id) =>
				attemptNavigation(() => {
					const next = new URLSearchParams(searchParams);
					next.set("tab", id);
					next.delete("review");
					next.delete("focus");
					const state = view === "loadout" ? { ...location.state, projectLoadout: {
            ...readLoadoutReturn(location.state, projectName), ...loadoutViewportSnapshot(),
          } } : location.state;
          navigate({ search: `?${next.toString()}` }, { replace: true, state });
					setView(id);
				})
			}
			expanded={false}
		/>
	);

	// --- mutations --------------------------------------------------------

	async function createEnvFile() {
		try {
			await invoke("create_empty_file", { path: envPath });
			await queryClient.invalidateQueries({
				queryKey: qk.envExists(projPath ?? ""),
			});
			toast.push({ kind: "success", title: "Created .env", body: envPath });
		} catch (err) {
			toast.error("Couldn't create .env", errorDetail(err).headline);
		}
	}

	// Thin alias over the shared wrapper: a non-zero exit becomes a
	// `HubCommandError` whose message is the real (stderr-first, ANSI-stripped)
	// error line rather than the raw stdout+stderr blob.
	async function runHubCmd(args: string[]): Promise<void> {
		await sharedRunHubCmd(args);
	}

	// Rename in place (the header's inline field). The route carries the name,
	// so the screen follows the rename — and follows it back on undo — with a
	// `replace` so the old name does not linger as a dead history entry.
	async function renameProject(next: string) {
		const previous = projectName!;
		try {
			await runUndoable({
				do: async () => {
					await runHubCmd(["project", "rename", previous, next]);
					navigate(`/project/${encodeURIComponent(next)}`, { replace: true });
				},
				undo: async () => {
					await runHubCmd(["project", "rename", next, previous]);
					navigate(`/project/${encodeURIComponent(previous)}`, { replace: true });
				},
				label: `Renamed ${previous} to ${next}`,
				invalidate: [["registry"], ["syncReport"]],
			});
		} catch (err) {
			toast.error("Couldn't rename project", errorDetail(err).headline);
			throw err;
		}
	}

	async function adoptCandidate(cand: ProjectSkillCandidate) {
		try {
			await runHubCmd([
				"project",
				"import-skill",
				cand.name,
				"--project",
				projectName!,
			]);
			await Promise.all([
				invalidateRegistry(queryClient),
				queryClient.invalidateQueries({
					queryKey: qk.projectCandidates(projectName ?? ""),
				}),
			]);
			toast.push({
				kind: "success",
				title: "Imported to library",
				body: `${cand.name} — now equipped on ${projectName}`,
			});
		} catch (err) {
			toast.error("Couldn't import skill", errorDetail(err).headline);
			throw err;
		}
	}

	// enable/disable & bundle apply/remove are reversible edges — they get
	// undo-instead-of-confirm via `useUndoableAction` (D4). Destructive actions
	// (remove project) keep their ConfirmDialog.
	async function enableSkill(skillName: string) {
		if (equipStatus[skillName] === "pending") return;
		setEquipStatus((current) => ({ ...current, [skillName]: "pending" }));
		try {
			await feedback({
				title: `Equipped ${skillName} on ${projectName}`,
				write: () => gate.equip(skillName, projectName!),
				undo: () => runHubCmd(["disable", skillName, "--project", projectName!]),
				skillNames: [skillName],
				readRefs: buildRefsGuardrailDeps(toast.push, projectName!).readEnv,
				equipRefs: equipSkillRefsOnly,
				duration: UNDO_TOAST_DURATION_MS,
			});
			await invalidateRegistry(queryClient);
			// A write may settle after navigation already ran the timer cleanup.
			if (!mounted.current) return;
			setEquipStatus((current) => ({ ...current, [skillName]: "success" }));
			equipFadeTimers.current.push(
				window.setTimeout(() => {
					setEquipStatus((current) => {
						if (current[skillName] !== "success") return current;
						const { [skillName]: _removed, ...rest } = current;
						return rest;
					});
				}, 900),
			);
		} catch (err) {
			if (mounted.current) setEquipStatus((current) => ({ ...current, [skillName]: "error" }));
			const failure = equipErrorToast(err);
			toast.error(failure.title, failure.body);
		}
	}

	// Unequip mirrors enable's optimistic per-item feedback (B1-09): the card
	// shows a pending/disabled state via the same `equipStatus` map while the
	// disable mutation is in flight, so removal is acknowledged inline (not only
	// by the undo toast). Guarded so a second click can't double-fire.
	//
	// This does NOT go through `useUndoableAction` (C8): `hub disable … --json`
	// reports what it removed as its FIRST stdout line (A13), and the undo must
	// replay exactly that — `--with-companions` only when it actually removed
	// some, never guessed. `UndoableAction` has no slot for a toast BODY (only
	// a title), so the removal sentence needs its own `toast.push` here.
	async function disableSkill(skillName: string) {
		if (equipStatus[skillName] === "pending") return;
		setEquipStatus((current) => ({ ...current, [skillName]: "pending" }));
		let payload: DisablePayload | undefined;
		let hadCompanions = false;
		try {
			await feedback({
				title: `Unequipped ${skillName} from ${projectName}`,
				write: async () => {
					const res = await sharedRunHubCmd(["disable", skillName, "--project", projectName!, "--json"]);
					payload = parseCmdPayload<DisablePayload>(res.output) ?? undefined;
					const removed = payload?.removed_companions;
					hadCompanions = !!removed && (removed.hooks.length > 0 || removed.agents.length > 0 || removed.permissions.length > 0);
				},
				undo: async () => {
					await gate.equip(skillName, projectName!, { force: hadCompanions ? "with" : "only" });
					await invalidateRegistry(queryClient);
				},
				appendDetail: () => payload ? removalSentence(payload) : undefined,
				duration: UNDO_TOAST_DURATION_MS,
			});
			await invalidateRegistry(queryClient);
			// On success the card leaves the equipped grid on the next registry
			// read; drop the pending key so nothing lingers if it doesn't.
			setEquipStatus((current) => {
				if (current[skillName] !== "pending") return current;
				const { [skillName]: _removed, ...rest } = current;
				return rest;
			});
		} catch (err) {
			setEquipStatus((current) => {
				const { [skillName]: _removed, ...rest } = current;
				return rest;
			});
			toast.error("Couldn't unequip skill", errorDetail(err).headline);
		}
	}

	async function applyBundle(bundleName: string) {
		try {
			const skills = registry?.bundles[bundleName]?.skills ?? [];
			await feedback({
				project: projectName,
				title: `Applied ${bundleName} to ${projectName}`,
				subject: bundleName,
				write: () => runHubCmd(["bundle", "apply", bundleName, "--project", projectName!]).then(() => undefined),
				undo: () => runHubCmd(["bundle", "remove", bundleName, "--project", projectName!]).then(() => undefined),
				skillNames: skills,
				readRefs: buildRefsGuardrailDeps(toast.push, projectName!).readEnv,
				equipRefs: equipSkillRefsOnly,
				duration: UNDO_TOAST_DURATION_MS,
			});
		} catch (err) {
			toast.error("Couldn't apply bundle", errorDetail(err).headline);
		}
	}

	async function removeBundle(bundleName: string) {
		const key = JSON.stringify([projectName, bundleName]);
		if (removingBundles.has(key)) return;
		setRemovingBundles((current) => new Set(current).add(key));
		try {
			await feedback({
				project: projectName,
				title: registry?.bundles[bundleName]?.scope === "global" ? `Removed ${bundleName}'s project attachment; still applied globally` : `Removed ${bundleName} from ${projectName}`,
				subject: bundleName,
				write: () => runHubCmd(["bundle", "remove", bundleName, "--project", projectName!]).then(() => undefined),
				undo: () => runHubCmd(["bundle", "apply", bundleName, "--project", projectName!]).then(() => undefined),
				duration: UNDO_TOAST_DURATION_MS,
			});
		} catch (err) {
			toast.error("Couldn't remove bundle", errorDetail(err).headline);
		} finally {
			setRemovingBundles((current) => {
				const next = new Set(current);
				next.delete(key);
				return next;
			});
		}
	}

	// Per-project invocation override — reversible, so it gets an undo toast.
	// `inherit` clears the override; undo restores the previous state (which may
	// itself be "no override" → `inherit`).
	async function setInvocationOverride(
		skillName: string,
		choice: OverrideChoice,
		previous: "auto" | "user-only" | "model-only" | undefined,
	) {
		const prevMode = previous ?? "inherit";
		try {
			await runUndoable({
				do: () =>
					runHubCmd([
						"project",
						"invocation",
						projectName!,
						"--skill",
						skillName,
						"--mode",
						choice,
					]),
				undo: () =>
					runHubCmd([
						"project",
						"invocation",
						projectName!,
						"--skill",
						skillName,
						"--mode",
						prevMode,
					]),
				label:
					choice === "inherit"
						? `Cleared triggering override for ${skillName}`
						: `Set ${skillName} triggering to ${choice} on ${projectName}`,
				invalidate: [qk.registry(), qk.syncReport(), qk.invocationAll()],
			});
		} catch (err) {
			toast.error("Couldn't set triggering override", errorDetail(err).headline);
		}
	}

	function handleDrop(zone: "equipped" | "avail", skillName: string) {
		setDragOver(null);
		if (!skillName) return;
		const inDirect = proj.enabled.includes(skillName);
		if (zone === "equipped") {
			if (!inDirect) void enableSkill(skillName);
		} else if (zone === "avail") {
			if (inDirect) void disableSkill(skillName);
		}
	}

	let body: ReactNode;
	if (proj.path_unresolved && ["agent-docs", "subagents"].includes(view)) {
		body = <>
			<ScreenHeader title={projectName} />
			{navigator}
			<div className="screen-pad">
				<p>No local directory attached. Attach a directory to inspect or edit local configuration.</p>
				<Button onClick={() => navigate(`/recovery?project=${encodeURIComponent(projectName)}`)}>
					Attach directory
				</Button>
			</div>
		</>;
	} else if (view === "agent-docs") {
		body = (
			<AgentDocsView
				projectName={projectName}
				projectPath={proj.path}
				navigator={navigator}
				projectHarnesses={[
					...(registry.harnesses_global ?? []),
					...(proj.harnesses ?? []),
				]}
				globalHarnesses={registry.harnesses_global ?? []}
				ownHarnesses={proj.harnesses ?? []}
			/>
		);
	} else if (view === "permissions") {
		body = (
			<ProjectPermissionsTab
				projectName={projectName}
				projectPath={proj.path}
				navigator={navigator}
			/>
		);
	} else if (view === "subagents") {
		// Effective harnesses for this project (global ∪ project). Codex is
		// user-scope only — its agents live at /harness/codex, not here — so the
		// hint is shown ONLY when codex is actually active, where it's relevant.
		const codexActive = new Set([
			...(registry.harnesses_global ?? []),
			...(proj.harnesses ?? []),
		]).has("codex");
		body = (
			<ProjectSubagentsTab
				projectName={projectName}
				navigator={navigator}
				equippedCount={equipped.length}
				codexActive={codexActive}
				onNavigate={navigate}
			/>
		);
	} else if (view === "usage") {
		body = <ProjectUsageTab projectName={projectName} navigator={navigator} />;
	} else {
		body = (
			<ProjectLoadoutView
				key={projectName}
				projectName={projectName}
				proj={proj}
				registry={registry}
				navigator={navigator}
				envExists={envExists}
				envPath={envPath}
				syncEnvelope={syncEnvelope}
				freshness={freshness}
				equipped={equipped}
				globalBundles={globalBundles}
				availableBundles={availableBundles}
				affinitySkips={affinitySkips}
				missingRefs={missingRefs}
				companionsReconcile={companionsReconcile}
				localCandidates={localCandidates}
				installedHarnessIds={installedHarnessIds}
				bundleProvidedSet={bundleProvidedSet}
				dragOver={dragOver}
				equipStatus={equipStatus}
				availQuery={availQuery}
				expandedAvailable={expandedAvailable}
				scopeGroups={scopeGroups}
				filteredUnequipped={filteredUnequipped}
				availNav={availNav}
				availRowIndex={availRowIndex}
				onSetDragOver={setDragOver}
				onSetAvailQuery={setAvailQuery}
				onToggleAvailableDetails={toggleAvailableDetails}
				onCreateEnvFile={createEnvFile}
				onRunSync={runSync}
				syncing={syncing}
				onRenameProject={renameProject}
					onOpenEditPath={() => setShowEditPath(true)}
				onOpenRepository={() => setShowRepository(true)}
				onOpenRemove={() => setShowRemove(true)}
				onEnableSkill={enableSkill}
				onDisableSkill={disableSkill}
				onApplyBundle={applyBundle}
				onRemoveBundle={removeBundle}
				removingBundles={proj.bundles.filter((bn) => removingBundles.has(JSON.stringify([projectName, bn])))}
				onSetInvocationOverride={setInvocationOverride}
				onAdoptCandidate={adoptCandidate}
				onDrop={handleDrop}
			/>
		);
	}

	return (
		<>
			<ProjectReviewProvider projectName={projectName}>{body}</ProjectReviewProvider>
			<EditProjectPathDialog
				open={showEditPath}
				onClose={() => setShowEditPath(false)}
				projectName={projectName}
				currentPath={proj.path}
			/>
			<ProjectRepositoryDialog
				open={showRepository}
				onClose={() => setShowRepository(false)}
				projectName={projectName}
			/>
			<RemoveProjectDialog
				open={showRemove}
				onClose={() => setShowRemove(false)}
				projectName={projectName}
				onRemoved={() => { removeProjectLoadoutOrder(proj.path); navigate("/"); }}
			/>
		</>
	);
}
