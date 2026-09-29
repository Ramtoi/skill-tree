import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { EmptyState } from "@/components/EmptyState";
import { Field, MetaGrid } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { StatusBadge } from "@/components/StatusBadge";
import { Tag } from "@/components/Tag";
import { ConfirmDialog } from "@/components/Modal";
import { HookActionEditor } from "@/components/HookActionEditor";
import { useToast } from "@/components/Toast";
import { HookAppliesToBlock, HookDefinitionBlock } from "@/components/hooks/HookDefinitionBlock";
import { HookSidePanel } from "@/components/hooks/HookSidePanel";
import { SourceViewer } from "@/components/hooks/SourceViewer";
import { backReturnOptions, fromNav, useBackTarget } from "@/lib/backTarget";
import { useRegistry } from "@/hooks/useRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useHookDraft } from "@/hooks/useHookDraft";
import { usePermissionRisksSchema } from "@/hooks/usePermissions";
import {
	useHook,
	useHookCapabilities,
	useHookDoctor,
	useHookNew,
	useHookEdit,
	useHookDelete,
	useHookScript,
	useHookScriptSave,
	useHookSetSettings,
} from "@/hooks/useHooks";
import { hookToolGroups } from "@/lib/hookCatalog";
import { hookRiskLabel } from "@/lib/hookRisks";
import {
	deriveActionMode,
	hasLegacyBothMatcherAndTools,
	hookHealth,
	hookHealthChannel,
	hookSummary,
	managedScriptStub,
	validateRepoScriptPath,
	type ActionMode,
	type AppliesMode,
	type Interpreter,
} from "@/lib/hookForm";

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Hook editor (`/hook/:name`). A FORM composed from primitives, restructured by
 * hook-editor-redesign:
 *
 *   main   Definition (name/description/event) → Action (D3) → Applies to (D2)
 *   side   Harnesses (D1) → Advanced → Settings → Danger zone
 *
 * The three redesign pillars:
 *  * D1 — ONE harness panel merges the affinity toggles with the per-event reach
 *    verdicts, killing the two-lists-that-look-identical confusion.
 *  * D2 — "applies to" is a segmented mode (all / specific tools / raw matcher)
 *    DERIVED from the data, not a wall of ~50 checkboxes plus a rogue regex box.
 *  * D3 — "action" is a segmented mode: shell command, hub-managed script (edited
 *    in place), or a repo script.
 *
 * `name === "new"` is create mode. Built-ins render their definition as read-only
 * SUMMARY rows (D5) — no disabled inputs — with Settings as the primary editable
 * block. `⌘S` saves the form AND a dirty managed-script body in one action.
 *
 * The main and side columns are composed from `HookDefinitionBlock` and
 * `HookSidePanel` (side-panels wave 4) — extracted so this screen stays under
 * the 1000-line component-size cap once the native `<select>`s became `Select`
 * and the two hand-rolled tablists became `ChipRadios`.
 */
export function HookEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const isNew = routeName === "new";
	const navigate = useNavigate();
	const toast = useToast();
	// D14: a hook opened from a skill's SHIPS WITH row returns to that skill —
	// the Hooks list is only the fallback for a deep link or a palette jump.
	// Label stays lowercase "hooks" (not "Hooks") to match the screen's
	// pre-existing "Back to hooks" copy (`HookErrorStates.test.tsx`'s
	// no-referrer case) — a cosmetic choice, not part of D14's substance.
	const back = useBackTarget({ label: "hooks", path: "/hooks", crumbs: ["hooks"] });
	const { data: registry } = useRegistry();
	const { data: capabilities } = useHookCapabilities();
	const harnesses = useHarnesses();
	const installedHarnesses = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);

	const { data: hook, isLoading, error } = useHook(isNew ? undefined : routeName);
	const { data: doctor } = useHookDoctor();
	const { data: riskSchema } = usePermissionRisksSchema();
	const newMut = useHookNew();
	const editMut = useHookEdit();
	const deleteMut = useHookDelete();
	const settingsMut = useHookSetSettings();
	const scriptSaveMut = useHookScriptSave();

	const isBuiltin = hook?.provenance === "builtin";
	const coreReadOnly = isBuiltin; // built-in command/event/tools/matcher/etc.

	/** What the SERVER currently thinks this hook runs — the baseline a mode
	 *  switch is destructive against (a managed script file gets deleted). */
	const serverActionMode: ActionMode = hook ? deriveActionMode(hook) : "command";

	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmScriptDrop, setConfirmScriptDrop] = useState(false);

	// The managed body only matters (and only exists) for a managed-script hook.
	const scriptQuery = useHookScript(routeName, !isNew && serverActionMode === "managed");

	// Core-field form state + its identity-keyed hydration (from the loaded
	// definition and its managed script body). See useHookDraft for why the
	// hydration guards can't be split from their effects.
	const {
		name,
		setName,
		description,
		setDescription,
		event,
		setEvent,
		command,
		setCommand,
		actionMode,
		setActionMode,
		interpreter,
		setInterpreter,
		scriptPath,
		setScriptPath,
		scriptArgs,
		setScriptArgs,
		scriptBody,
		setScriptBody,
		scriptBodyDirty,
		setScriptBodyDirty,
		appliesMode,
		setAppliesMode,
		tools,
		setTools,
		matcher,
		setMatcher,
		timeout,
		setTimeoutVal,
		affinity,
		setAffinity,
		dirty,
		mark,
		anythingDirty,
		bodyHydratedFor,
		reset,
	} = useHookDraft({
		hook,
		isNew,
		routeName,
		scriptPayload: scriptQuery.data,
	});

	const toolGroups = useMemo(() => hookToolGroups(registry), [registry]);
	const legacyBoth = hasLegacyBothMatcherAndTools({ tools, matcher });

	const summary = useMemo(
		() =>
			hookSummary({
				event,
				appliesMode,
				tools,
				matcher,
				actionMode,
				scriptPath,
				affinity,
				builtin: isBuiltin,
			}),
		[event, appliesMode, tools, matcher, actionMode, scriptPath, affinity, isBuiltin],
	);

	const health = useMemo(
		() => hookHealth(doctor?.findings, hook?.name ?? routeName ?? ""),
		[doctor, hook, routeName],
	);

	/** Absolute path of the managed script a mode switch (or a delete) would
	 *  destroy — ONLY when the backend has told us what it is. The hooks dir
	 *  follows `data_home()` (`$SKILL_HUB_HOME`, a legacy home, …), so any path
	 *  the frontend composes itself is a guess; a guessed absolute path in a
	 *  destructive confirm is worse than no path at all. Unknown ⇒ prose. */
	const managedPath = scriptQuery.data?.path || null;

	/** What a destructive confirm calls the managed script file. */
	const managedTarget = managedPath ?? "its managed script file";

	function changeActionMode(next: ActionMode) {
		if (coreReadOnly || next === actionMode) return;
		if (next === "managed" && !scriptBody.trim()) {
			// A brand-new managed script starts from a runnable stub rather than an
			// empty file that would silently no-op at the first event.
			setScriptBody(managedScriptStub(interpreter));
			setScriptBodyDirty(true);
		}
		mark(setActionMode)(next);
	}

	function changeInterpreter(next: Interpreter) {
		if (coreReadOnly) return;
		// A body that is STILL the untouched stub follows the interpreter; anything
		// the user actually wrote is never rewritten under them.
		if (scriptBody === managedScriptStub(interpreter)) {
			setScriptBody(managedScriptStub(next));
		}
		mark(setInterpreter)(next);
	}

	function changeAppliesMode(next: AppliesMode) {
		if (coreReadOnly || next === appliesMode) return;
		mark(setAppliesMode)(next);
	}

	/** The tools/matcher pair the CURRENT applies-mode means. Switching modes
	 *  clears the other representation, so what the segmented control claims is
	 *  exactly what gets written (no invisible leftover matcher winning later). */
	function resolvedMatching(): { tools: string[]; matcher: string } {
		if (appliesMode === "matcher") return { tools: [], matcher: matcher.trim() };
		if (appliesMode === "tools") return { tools, matcher: "" };
		return { tools: [], matcher: "" };
	}

	const doSave = useCallback(
		async (confirmedScriptDrop: boolean) => {
			if (coreReadOnly) return;
			const canonical = name.trim();
			if (isNew && !SLUG_RE.test(canonical)) {
				toast.error("Hook name must use lowercase letters, numbers, and hyphens");
				return;
			}
			if (actionMode === "command" && !command.trim()) {
				toast.error("Command is required");
				return;
			}
			if (actionMode === "repo") {
				const pathErr = validateRepoScriptPath(scriptPath);
				if (pathErr) {
					toast.error(pathErr);
					return;
				}
			}
			if (appliesMode === "matcher" && !matcher.trim()) {
				toast.error("A raw matcher is required in Raw matcher mode");
				return;
			}
			if (appliesMode === "tools" && tools.length === 0) {
				toast.error("Pick at least one tool, or switch to All tools");
				return;
			}
			const timeoutNum =
				timeout.trim() === "" ? null : Number.parseInt(timeout, 10);
			if (timeoutNum != null && Number.isNaN(timeoutNum)) {
				toast.error("Timeout must be a number of seconds");
				return;
			}

			// Switching away from a managed script DELETES the file on save (D6).
			// Name the concrete path before doing it — this is not undoable.
			if (
				!isNew &&
				serverActionMode === "managed" &&
				actionMode !== "managed" &&
				!confirmedScriptDrop
			) {
				setConfirmScriptDrop(true);
				return;
			}

			const matching = resolvedMatching();
			const scriptFields =
				actionMode === "command"
					? { scriptSource: "" as const }
					: {
							scriptSource: actionMode,
							scriptInterpreter: interpreter,
							scriptArgs,
							...(actionMode === "repo" ? { scriptPath: scriptPath.trim() } : {}),
						};

			try {
				if (isNew) {
					const res = await newMut.mutateAsync({
						name: canonical,
						event,
						description: description.trim() || undefined,
						...(actionMode === "command"
							? { command }
							: {
									scriptSource: actionMode,
									scriptInterpreter: interpreter,
									scriptArgs,
									...(actionMode === "repo"
										? { scriptPath: scriptPath.trim() }
										: { scriptBody }),
								}),
						tools: matching.tools,
						matcher: matching.matcher || undefined,
						timeout: timeoutNum,
						harnesses: affinity.length ? affinity : undefined,
					});
					if (!res.success) throw new Error(res.output);
					reset();
					toast.success(`Created hook "${canonical}"`);
					navigate(`/hook/${encodeURIComponent(canonical)}`, { ...fromNav(back), replace: true });
				} else {
					const res = await editMut.mutateAsync({
						name: canonical,
						event,
						description,
						...(actionMode === "command" ? { command } : {}),
						...scriptFields,
						tools: matching.tools,
						matcher: matching.matcher,
						timeout: timeoutNum,
						harnesses: affinity,
					});
					if (!res.success) throw new Error(res.output);
					// The body is a separate artifact on disk; ⌘S is ONE user action
					// that lands both. A failure here must NOT report a clean save.
					if (actionMode === "managed" && scriptBodyDirty) {
						// Fail closed: the buffer is only ever written under the hook it
						// was hydrated (or stub-seeded) for. Writing an unowned buffer
						// would silently overwrite this hook's script with another's.
						if (bodyHydratedFor.current !== (routeName ?? "")) {
							throw new Error(
								"The script buffer belongs to a different hook — reopen this hook and try again.",
							);
						}
						const bodyRes = await scriptSaveMut.mutateAsync({
							name: canonical,
							body: scriptBody,
						});
						if (!bodyRes.success) throw new Error(bodyRes.output);
					}
					reset();
					toast.success(`Saved hook "${canonical}"`);
				}
			} catch (e) {
				toast.error("Couldn't save hook", String(e));
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			coreReadOnly,
			isNew,
			name,
			description,
			event,
			command,
			actionMode,
			interpreter,
			scriptPath,
			scriptArgs,
			scriptBody,
			scriptBodyDirty,
			appliesMode,
			tools,
			matcher,
			timeout,
			affinity,
			serverActionMode,
			routeName,
			newMut,
			editMut,
			scriptSaveMut,
			toast,
			navigate,
		],
	);

	const save = useCallback(() => void doSave(false), [doSave]);

	// ⌘S / Ctrl+S saves when dirty (mirrors the editor keyboard contract).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				if ((dirty || scriptBodyDirty) && !coreReadOnly) save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, scriptBodyDirty, coreReadOnly, save]);

	const doDelete = useCallback(async () => {
		if (!hook) return;
		try {
			const res = await deleteMut.mutateAsync({ name: hook.name, confirm: true });
			if (!res.success) throw new Error(res.output);
			toast.success(`Deleted hook "${hook.name}"`);
			navigate(back.path, backReturnOptions(back));
		} catch (e) {
			toast.error("Couldn't delete hook", String(e));
		} finally {
			setConfirmDelete(false);
		}
	}, [hook, deleteMut, toast, navigate]);

	// ─── Guards ───────────────────────────────────────────────────────────────
	if (!isNew && error) {
		// C4: same chrome as the loading branch below — a dead deep link still
		// tells you where you are and how to get out.
		return (
			<>
				<ScreenHeader
					back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
					nameMono={routeName}
					crumbs={[...(back.crumbs ?? [back.label]), routeName ?? ""]}
				/>
				<div className="main-body">
					<EmptyState
						icon="warning"
						title="Hook not found"
						description={`No hook named ${routeName}`}
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
	if (!isNew && (isLoading || !hook)) {
		// C4: the chrome is not part of the payload. Loading renders the same
		// header box, so the body doesn't drop 57px the moment the query lands.
		return (
			<>
				<ScreenHeader
					back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
					nameMono={routeName}
					crumbs={[...(back.crumbs ?? [back.label]), routeName ?? ""]}
				/>
				<div className="hook-editor-loading text-dim">Loading…</div>
			</>
		);
	}

	async function saveHookSettings(scope: string, settings: Record<string, unknown>) {
		if (!hook) return;
		const res = await settingsMut.mutateAsync({
			name: hook.name,
			settings,
			global: scope === "__global__",
			project: scope === "__global__" ? undefined : scope,
		});
		if (!res.success) throw new Error(res.output);
	}

	return (
		<>
			<ScreenHeader
				back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
				nameMono={isNew ? "new hook" : name}
				crumbs={[...(back.crumbs ?? [back.label]), isNew ? "new" : name]}
				meta={
					!isNew && hook ? (
						<Tag size="sm">{hook.provenance}</Tag>
					) : (
						<Tag size="sm">user</Tag>
					)
				}
				state={anythingDirty ? <StatePill state="unsaved">UNSAVED</StatePill> : null}
				primary={
					<Button
						variant="primary"
						icon="save"
						onClick={save}
						disabled={coreReadOnly || (!isNew && !anythingDirty)}
						disabledReason={
							coreReadOnly
								? "Built-in command/event are read-only — edit its settings below."
								: undefined
						}
					>
						{isNew ? "Create hook" : "Save"}
					</Button>
				}
			/>

			<div className="hook-editor">
				{/* The "what did I just build" anchor — recomputed from form state,
				    never from the server copy (D4). */}
				<div className="hook-summary" aria-label="hook summary">
					{summary}
				</div>

				{health.worst !== null && (
					<div className="hook-health" aria-label="hook health">
						{health.items.map((f, i) => (
							<div key={`${f.code}-${i}`} className="hook-health-row">
								<StatusBadge
									channel={hookHealthChannel(f.severity)}
									shape="pill"
									icon={f.severity === "info" ? "info" : "warning"}
								>
									{f.severity}
								</StatusBadge>
								<span className="hook-health-label">
									{hookRiskLabel(f.code, riskSchema)}
								</span>
								<span className="hook-health-detail text-dim">{f.detail}</span>
							</div>
						))}
					</div>
				)}

				{coreReadOnly && (
					<div className="hook-builtin-note">
						<Icon name="link" size={12} />
						<span>
							Built-in hook — its definition is read-only. Adjust its behaviour in
							the settings below. It can't be deleted; detach it from a scope
							instead (Attach / Detach from the palette or project card).
						</span>
					</div>
				)}

				<div className="hook-editor-cols">
					{/* ─── Main form column ─── */}
					<div className="hook-editor-main">
						<HookDefinitionBlock
							isNew={isNew}
							coreReadOnly={coreReadOnly}
							name={name}
							onNameChange={mark(setName)}
							description={description}
							onDescriptionChange={mark(setDescription)}
							event={event}
							onEventChange={mark(setEvent)}
						/>

						<div className="side-panel-block">
							<h4>Action</h4>
							{coreReadOnly ? (
								<MetaGrid>
									<Field
										label="runs"
										full
										hint={
											hook?.baked_command == null
												? "Could not resolve the baked command — showing the definition's command."
												: "What the harness receives after sync — interpreter and paths baked in."
										}
									>
										<div
											className="hook-ro-value text-mono hook-baked-command"
											aria-label="command"
										>
											{hook?.baked_command ?? command}
										</div>
									</Field>
									{hook?.builtin && hook.builtin.files.length > 0 && (
										<Field label="source" full>
											<SourceViewer
												files={hook.builtin.files.map((f) => ({
													id: f.name,
													label: f.name,
													body: f.body,
												}))}
												idPrefix="hook-builtin-source"
												ariaLabel="Built-in source files"
												resetKey={routeName}
											/>
										</Field>
									)}
								</MetaGrid>
							) : (
								<HookActionEditor
									mode={actionMode}
									onModeChange={changeActionMode}
									command={command}
									onCommandChange={mark(setCommand)}
									interpreter={interpreter}
									onInterpreterChange={changeInterpreter}
									scriptPath={scriptPath}
									onScriptPathChange={mark(setScriptPath)}
									scriptArgs={scriptArgs}
									onScriptArgsChange={mark(setScriptArgs)}
									body={scriptBody}
									onBodyChange={(v) => {
										setScriptBody(v);
										setScriptBodyDirty(true);
									}}
									bodyLoading={
										actionMode === "managed" &&
										serverActionMode === "managed" &&
										scriptQuery.isLoading
									}
									bodyMissing={
										actionMode === "managed" &&
										serverActionMode === "managed" &&
										!!scriptQuery.data &&
										scriptQuery.data.body == null
									}
									scriptProjects={hook?.script_projects}
									managedPath={managedPath ?? undefined}
									bakedCommand={hook?.baked_command}
									commandScript={hook?.command_script}
									conversion={hook?.repo_script_conversion}
									onReveal={(p) => void revealItemInDir(p)}
									hookName={routeName}
									onConvert={() => {
										const conv = hook?.repo_script_conversion;
										if (!conv) return;
										mark(setActionMode)("repo");
										mark(setInterpreter)(conv.interpreter as Interpreter);
										mark(setScriptPath)(conv.path);
										mark(setScriptArgs)(conv.args);
									}}
								/>
							)}
						</div>

						<HookAppliesToBlock
							coreReadOnly={coreReadOnly}
							appliesMode={appliesMode}
							onAppliesModeChange={changeAppliesMode}
							tools={tools}
							onToolsChange={mark(setTools)}
							matcher={matcher}
							onMatcherChange={mark(setMatcher)}
							toolGroups={toolGroups}
							legacyBoth={legacyBoth}
						/>
					</div>

					{/* ─── Side panel ─── */}
					<HookSidePanel
						hook={hook}
						isNew={isNew}
						isBuiltin={isBuiltin}
						coreReadOnly={coreReadOnly}
						installedHarnesses={installedHarnesses}
						affinity={affinity}
						onAffinityChange={mark(setAffinity)}
						capabilities={capabilities}
						event={event}
						timeout={timeout}
						onTimeoutChange={mark(setTimeoutVal)}
						projects={Object.keys(registry?.projects ?? {})}
						onSettingsSave={saveHookSettings}
						onDeleteClick={() => setConfirmDelete(true)}
					/>
				</div>
			</div>

			<ConfirmDialog
				open={confirmScriptDrop}
				onClose={() => setConfirmScriptDrop(false)}
				onConfirm={() => {
					setConfirmScriptDrop(false);
					void doSave(true);
				}}
				title="Delete the managed script?"
				tone="danger"
				confirmLabel="Delete script and save"
				confirmIcon="trash"
				body={
					<p>
						Switching this hook away from a managed script deletes its script file.
						This cannot be undone.
					</p>
				}
				blastRadius={
					<div className="hook-script-drop">
						<div className="text-dim">Will delete:</div>
						<div className={managedPath ? "text-mono" : undefined}>
							{managedTarget}
						</div>
					</div>
				}
			/>

			{hook && (
				<ConfirmDialog
					open={confirmDelete}
					onClose={() => setConfirmDelete(false)}
					onConfirm={() => void doDelete()}
					title={`Delete hook "${hook.name}"?`}
					tone="danger"
					confirmLabel="Delete"
					confirmIcon="trash"
					busy={deleteMut.isPending}
					body={
						<p>
							This deletes the definition and detaches it everywhere it's
							attached.
						</p>
					}
					blastRadius={
						<>
							<div className="hook-delete-scopes">
								<div className="text-dim">Will detach from:</div>
								<ul>
									{hook.attached_global && <li>global (all sessions)</li>}
									{hook.attached_projects.map((p) => (
										<li key={p} className="text-mono">
											project: {p}
										</li>
									))}
									{!hook.attached_global &&
										hook.attached_projects.length === 0 && (
											<li className="text-dim">not attached anywhere</li>
										)}
								</ul>
							</div>
							{/* `hub hook delete` also removes the managed script file. The
							    scopes list alone let the one UNRECOVERABLE consequence —
							    the script the user wrote in this editor — go unmentioned. */}
							{serverActionMode === "managed" && (
								<div className="hook-delete-script">
									<div className="text-dim">Will delete:</div>
									<div className={managedPath ? "text-mono" : undefined}>
										{managedTarget}
									</div>
								</div>
							)}
						</>
					}
				/>
			)}
		</>
	);
}
