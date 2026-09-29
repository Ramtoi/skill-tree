import { useCallback, useMemo, useRef, useState } from "react";
import { BackButton } from "@/components/BackButton";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Tag } from "@/components/Tag";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/Modal";
import { type CodeAreaHandle } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { useToast } from "@/components/Toast";
import {
	useAttachableSkills,
	useDeleteSubagent,
	useLinkSubagent,
	useProvisionSkill,
	useResolveDrift,
	useSaveSubagent,
	useSetSubagentDisabled,
	useSubagent,
	useUnlinkSubagent,
} from "@/hooks/useSubagents";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useRegistry } from "@/hooks/useRegistry";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { useSubagentDraft, useProvisionFlow } from "@/hooks/useSubagentDraft";
import {
	type NeedsProvisioning,
	type SubagentDriftField,
	type SubagentHarness,
	type SubagentSavePayload,
	type SubagentSaveResult,
	type SubagentScope,
} from "@/lib/subagents";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { subagentBackTarget } from "@/lib/backTarget";
import { attemptNavigation, useUnsavedGuard } from "@/lib/navGuard";
import { SubagentDangerZone } from "@/components/subagents/SubagentDangerZone";
import { SubagentFormPanel } from "@/components/subagents/SubagentFormPanel";
import { SubagentNameTitle } from "@/components/subagents/SubagentNameTitle";
import { RenamedPill } from "@/components/RenamedPill";
import { MarkdownToolbar } from "@/components/skillEditor/MarkdownToolbar";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";

/** `SidePanelSection` persistence-map key for the References section on the
 *  sub-agent editor's side panel. */
const SUBAGENT_EDITOR_SECTIONS_KEY = "st:subagent-editor:sections";

export interface SubagentEditorProps {
	/** Harness whose native file this edits (default claude-code). */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	/** The agent name to load; undefined never happens (new agents are created
	 *  via the sheet which then routes here). */
	name: string;
	onBack: () => void;
	/** R19: what the back arrow names — where `onBack` actually goes. The
	 *  manager passes the referrer's label for a `?agent=` deep link that
	 *  carried one; absent (an in-list open, or a stale referrer the manager
	 *  chose to ignore) the arrow closes back to the list. */
	backLabel?: string;
	/** Called after a rename so the parent can re-point its selection. */
	onRenamed?: (newName: string) => void;
	/** Called after a delete so the parent can clear its selection. */
	onDeleted?: () => void;
}

export function SubagentEditor({
	harness = "claude-code",
	scope,
	project,
	name,
	onBack,
	backLabel = "Sub-agents",
	onRenamed,
	onDeleted,
}: SubagentEditorProps) {
	const toast = useToast();
	const isCodex = harness === "codex";
	const { data: show, isLoading } = useSubagent(scope, project, name, harness);
	const { data: attachable } = useAttachableSkills(scope, project, true, harness);
	const saveMut = useSaveSubagent();
	const deleteMut = useDeleteSubagent(scope, project, harness);
	const disableMut = useSetSubagentDisabled(scope, project, harness);
	const linkMut = useLinkSubagent(scope, project);
	const unlinkMut = useUnlinkSubagent(scope, project);
	const resolveMut = useResolveDrift(scope, project);
	const provisionMut = useProvisionSkill(scope, project, harness);
	const harnessesList = useHarnesses();

	// ─── Linked-twin state (D3, user scope only) ────────────────────────────────
	const link = show?.link ?? null;
	const drift = useMemo<SubagentDriftField[]>(() => show?.drift ?? [], [show]);
	const driftedFields = useMemo(
		() => new Set(drift.map((d) => d.field)),
		[drift],
	);
	const descLocked = driftedFields.has("description");
	const skillsLocked = driftedFields.has("skills");
	const instructionsLocked = driftedFields.has("instructions");
	// Other agent-capable, installed harnesses — the copy/link targets.
	const otherTargets = harnessesList
		.filter((h) => h.id !== harness && h.agents?.supported && h.installed)
		.map((h) => h.id as SubagentHarness);
	const linkedOthers = (link?.harnesses ?? []).filter((h) => h !== harness);
	const [deleteBoth, setDeleteBoth] = useState(false);

	const draft = useSubagentDraft({ show, name, isCodex, harness, scope, project });

	// References (F5): the body's own backtick/slash mentions of registered
	// skills, decorated + hover-carded in Edit, linked in Preview, and listed
	// on the side panel. `host.self` stays unset — this buffer IS a doc, not a
	// skill, so it has no MENTIONED BY and no `refs_ignore`.
	const { data: registry } = useRegistry();
	const refsHost = useMemo(
		() => ({ back: subagentBackTarget({ harness, name, scope, project }) }),
		[harness, name, scope, project],
	);
	const refs = useSkillRefs({ host: refsHost, content: draft.body, registry });

	// The editor's own unsaved-buffer guard (F5) — no guard is armed elsewhere
	// for this screen today, so this is the only one. It catches every
	// programmatic navigation below it, including a reference ⌘-click/row
	// click, and the back arrow below (wrapped explicitly — `onBack` is a
	// `setSelected(null)` in the manager, component state the guard cannot see
	// on its own).
	const leaveGuard = useUnsavedGuard(draft.dirty);
	const handleBack = useCallback(() => attemptNavigation(onBack), [onBack]);

	// `handleSaveResult` (below) needs `provision.raise`/`provision.clear`, and
	// `useProvisionFlow` needs `handleSaveResult` as its `onSaveResult` — a ref
	// indirection breaks the definition-order cycle without either side losing
	// access to the other's latest closure.
	const handleSaveResultRef = useRef<
		(res: SubagentSaveResult, payload: SubagentSavePayload) => boolean
	>(() => false);

	const provision = useProvisionFlow({
		provisionMut,
		saveMut,
		project,
		harness,
		onSaveResult: (res, payload) => handleSaveResultRef.current(res, payload),
	});

	const [mode, setMode] = useState<DocMode>("edit");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// M2: the live per-harness client message while the header name field is
	// open — mirrored from `InlineName` so it can render as a VISIBLE line,
	// not just `title`/`aria-invalid`.
	const [liveNameError, setLiveNameError] = useState<string | null>(null);

	const editorRef = useRef<CodeAreaHandle>(null);
	const disabled = show?.disabled ?? false;

	// Fold a save result into UI state. On a block whose ONLY errors carry
	// `needs_provisioning` we raise the consequence prompt instead of a bare
	// "fix errors" toast (field errors still render inline). Returns save success.
	const handleSaveResult = useCallback(
		(res: SubagentSaveResult, payload: SubagentSavePayload): boolean => {
			if (!res.ok) {
				const errs = res.errors ?? [];
				draft.setErrors(errs);
				const items: NeedsProvisioning[] = [];
				const seen = new Set<string>();
				for (const e of errs) {
					const np = e.needs_provisioning;
					if (np && !seen.has(np.skill)) {
						seen.add(np.skill);
						items.push(np);
					}
				}
				if (items.length) {
					provision.raise(items, payload);
				} else {
					provision.clear();
					toast.error(
						"Save blocked",
						errs.map((error) => error.message).filter(Boolean).join("\n") ||
							"The save was rejected without an explanation. Retry or reopen the agent.",
					);
				}
				return false;
			}
			draft.applySaveSuccess(payload.body, payload.advanced_yaml);
			provision.clear();
			const twinNote = res.cowrote_twin
				? `Also updated ${harnessLabel(res.twin_harness ?? "")}.`
				: undefined;
			if (res.warnings?.length) {
				toast.push({
					kind: "info",
					title: `Saved ${res.name}`,
					body: `${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"} — review the form.${twinNote ? ` ${twinNote}` : ""}`,
				});
				draft.setErrors(res.warnings);
			} else {
				toast.success(`Saved ${res.name}`, twinNote);
			}
			if (res.renamed_from && res.name && res.name !== name) {
				onRenamed?.(res.name);
			}
			return true;
		},
		[draft, provision, toast, name, onRenamed],
	);
	handleSaveResultRef.current = handleSaveResult;

	const save = useCallback(async () => {
		if (saveMut.isPending) return;
		draft.setErrors([]);
		if (!draft.nameValid) {
			draft.setErrors([
				{
					field: "name",
					level: "error",
					message: isCodex
						? "Name must use lowercase letters, numbers, hyphens, and underscores only."
						: "Name must use lowercase letters, numbers, and hyphens only.",
				},
			]);
			return;
		}
		const payload = draft.buildPayload();
		try {
			const res = await saveMut.mutateAsync(payload);
			handleSaveResult(res, payload);
		} catch (e) {
			toast.error("Couldn't save sub-agent", String(e));
		}
	}, [saveMut, draft, isCodex, handleSaveResult, toast]);

	async function toggleDisabled() {
		try {
			await disableMut.mutateAsync({ name, disabled: !disabled });
		} catch (e) {
			toast.error("Couldn't toggle sub-agent", String(e));
		}
	}

	async function doDelete() {
		try {
			const linkAction =
				link?.linked ? (deleteBoth ? "both" : "this") : undefined;
			const res = await deleteMut.mutateAsync({ name, linkAction });
			if (!res.ok) {
				const msg = res.errors?.map((e) => e.message).join("; ") || "could not delete";
				toast.error("Couldn't delete sub-agent", msg);
				return;
			}
			toast.success(
				`Deleted ${name}`,
				link?.linked
					? deleteBoth
						? "Both linked files removed."
						: "This harness's file removed; the twin was unlinked."
					: undefined,
			);
			leaveGuard.bypass(() => onDeleted?.());
		} catch (e) {
			toast.error("Couldn't delete sub-agent", String(e));
		}
	}

	// ─── Linked-twin actions (D3) ───────────────────────────────────────────────

	async function doLink(copyFrom?: SubagentHarness) {
		try {
			const res = await linkMut.mutateAsync({ name, copyFrom });
			if (!res.ok) {
				toast.error("Couldn't link sub-agent", res.error ?? "could not link");
				return;
			}
			toast.success(
				copyFrom ? `Copied ${name} to the linked harness` : `Linked ${name}`,
				copyFrom ? "The model reset to inherit in the new file." : undefined,
			);
		} catch (e) {
			toast.error("Couldn't link sub-agent", String(e));
		}
	}

	async function doUnlink() {
		try {
			await unlinkMut.mutateAsync(name);
			toast.success(`Unlinked ${name}`, "Both files remain; edits no longer co-write.");
		} catch (e) {
			toast.error("Couldn't unlink sub-agent", String(e));
		}
	}

	async function applyDrift(decisions: Record<string, SubagentHarness>) {
		try {
			const res = await resolveMut.mutateAsync({ name, decisions });
			if (!res.ok) {
				toast.error("Couldn't resolve drift", res.error ?? "could not resolve drift");
				return;
			}
			const remaining = res.drift?.length ?? 0;
			toast.success(
				remaining
					? `Applied — ${remaining} field${remaining === 1 ? "" : "s"} still differ`
					: `Drift resolved for ${name}`,
			);
		} catch (e) {
			toast.error("Couldn't resolve drift", String(e));
		}
	}

	const wrap = useCallback((left: string, right: string) => {
		editorRef.current?.wrapSelection(left, right);
	}, []);
	const prefixLine = useCallback((prefix: string) => {
		editorRef.current?.prefixLines(prefix);
	}, []);

	// Attention signal for the collapsed Details tab (B4b-02): the identity/name
	// error, the linked-twin drift banner, and the attach-skill provision prompt
	// all live in the Details side panel, which collapses to a vertical tab at
	// narrow widths. Surface a dot so these blocking states aren't hidden.
	// Declared before the not-found early return to keep hook order stable.
	const nameInvalid = !!draft.agentName.trim() && !draft.nameValid;
	const detailsAttention = useMemo<{ level: "error" | "warning" } | null>(() => {
		if (
			nameInvalid ||
			!!provision.provision ||
			draft.errors.some((e) => e.level === "error")
		)
			return { level: "error" };
		if (drift.length > 0) return { level: "warning" };
		return null;
	}, [nameInvalid, provision.provision, draft.errors, drift]);

	// Raw-escape-hatch format comes from `show` (yaml|toml); the harness is the
	// fallback for payloads that predate `advanced_format`.
	const advancedFormat =
		show?.advanced_format ?? (isCodex ? "toml" : "yaml");
	const foreignEntries = show?.foreign_skill_entries ?? [];

	if (!isLoading && (!show || !show.exists)) {
		// C4: a miss keeps the chrome — the user still needs to know where they
		// are and how to get out, and the band must not pop in behind them.
		return (
			<>
				<ScreenHeader
					back={{ label: backLabel, onClick: handleBack }}
					nameMono={name}
					crumbs={["harnesses", harness, "sub-agents", name]}
				/>
				<EmptyState
					icon="warning"
					title="Sub-agent not found"
					description={`No agent named ${name} in ${scope} scope`}
					action={<BackButton title={`Back to ${backLabel}`} onClick={handleBack}>Back</BackButton>}
				/>
			</>
		);
	}

	// The rename verb is already wired end to end (`original_name` → `renamed_from`);
	// the header stages it via `InlineName`, exactly like the skill/project headers.
	const nameError = draft.errorFor("name");
	// m1: the loaded name is the baseline for "renamed", not the route prop —
	// they can disagree (a file whose frontmatter name isn't its route key).
	const loadedName = show?.safe.name ?? name;
	const renamed = draft.agentName.trim() !== loadedName && draft.agentName.trim() !== "";

	return (
		<>
			<ScreenHeader
				back={{ label: backLabel, onClick: handleBack }}
				nameMono={
					<SubagentNameTitle
						name={draft.agentName || name}
						isCodex={isCodex}
						nameError={nameError}
						onChange={(next) => {
							// M1: staging anything other than the rejected value drops the
							// stale server error — it must not keep accusing a name the
							// header no longer shows.
							if (nameError && next !== nameError.value) {
								draft.setErrors(draft.errors.filter((e) => e.field !== "name"));
							}
							draft.markDirty(draft.setAgentName)(next);
						}}
						onValidityChange={setLiveNameError}
					/>
				}
				meta={
					<Tag size="sm" style={{ textTransform: "none" }}>
						{scope === "project" ? `project · ${project}` : "user"}
					</Tag>
				}
				state={
					disabled ? (
						<StatePill state="info" icon="power">
							DISABLED
						</StatePill>
					) : renamed ? (
						<RenamedPill />
					) : null
				}
				crumbs={["harnesses", harness, "sub-agents", draft.agentName || name]}
				overflow={[
					{
						icon: "power",
						label: disabled ? "Enable agent" : "Disable agent",
						onClick: () => void toggleDisabled(),
					},
					{ divider: true },
					{
						icon: "trash",
						label: "Delete agent",
						danger: true,
						onClick: () => setConfirmingDelete(true),
					},
				]}
			/>

			{/* The name error line — visible, never title/aria-only (M2). While the
			    header field is open, an invalid keystroke's live message (per
			    harness) wins; otherwise the server rename-collision error (only
			    known after ⌘S) stays on screen without re-opening the field (B2). */}
			{(liveNameError || nameError) && (
				<div className="field-error subagent-name-error" role="alert">
					{liveNameError ?? nameError?.message}
				</div>
			)}

			<div className="subagent-editor">
				<DocumentEditorShell
					content={draft.body}
					onContentChange={(v) => {
						draft.setBody(v);
						// CodeMirror emits the initial content on mount; only a real
						// divergence from the saved body counts as unsaved.
						if (v !== draft.savedBodyRef.current) draft.setDirty(true);
					}}
					editorRef={editorRef}
					extraExtensions={refs.extension}
					skillRefs={refs.render}
					mode={instructionsLocked ? "preview" : mode}
					onModeChange={setMode}
					modes={instructionsLocked ? ["preview"] : undefined}
					previewSource={draft.body}
					diffOriginal={draft.savedBodyRef.current}
					diffCurrent={draft.body}
					dirty={draft.dirty}
					onSave={() => void save()}
					// M4: while the staged name is still, unchanged, the one the
					// server just rejected, ⌘S must not resubmit it identically —
					// the alert line already on screen is the reason.
					saveDisabled={
						saveMut.isPending || draft.agentName.trim() === nameError?.value
					}
					detailsAttention={detailsAttention}
					splitStorageKey="st:layout:subagent-editor"
					headerExtras={
						instructionsLocked ? (
							<span
								className="subagent-drift-lockhint"
								role="alert"
								title="The system prompt has drifted between the linked files — resolve it in the form to edit."
							>
								<Icon name="warning" size={11} /> prompt drifted — resolve to edit
							</span>
						) : null
					}
					footerExtras={
						<>
						{/* Which document the body is — said from the footer, the same
						    slot the skill editor uses for its active file path, now that
						    the toolbar strip that used to carry this caption is gone. */}
						<span className="editor-active-path">
							<Icon name="doc" size={10} />
							<span>system prompt</span>
						</span>
						<span
							className="text-dim"
							style={{
								fontSize: 11,
								display: "inline-flex",
								gap: 4,
								alignItems: "center",
							}}
							title={`${harnessLabel(harness)} reads agent files at session start.`}
						>
							<Icon name="warning" size={11} />{" "}
							{isCodex
								? "Codex picks up agent file changes on the next session."
								: "Restart the Claude Code session to load disk edits"}
						</span>
						</>
					}
					toolbar={<MarkdownToolbar onWrap={wrap} onPrefixLine={prefixLine} />}
					dangerZone={
						<SubagentDangerZone
							disabled={disabled}
							confirmingDelete={confirmingDelete}
							deleteBoth={deleteBoth}
							linked={!!link?.linked}
							linkedOthers={linkedOthers}
							onToggleDisabled={() => void toggleDisabled()}
							onConfirmDelete={() => void doDelete()}
							onCancelDelete={() => setConfirmingDelete(false)}
							onStartDelete={() => setConfirmingDelete(true)}
							onDeleteBothChange={setDeleteBoth}
						/>
					}
					sidePanel={
						<>
							<SubagentFormPanel
								draft={draft}
								provision={provision}
								drift={drift}
								link={link}
								linkedOthers={linkedOthers}
								otherTargets={otherTargets}
								scope={scope}
								harness={harness}
								isCodex={isCodex}
								show={show}
								attachable={attachable}
								foreignEntries={foreignEntries}
								advancedFormat={advancedFormat}
								descLocked={descLocked}
								skillsLocked={skillsLocked}
								linkMut={linkMut}
								unlinkMut={unlinkMut}
								resolveMut={resolveMut}
								onLink={(copyFrom) => void doLink(copyFrom)}
								onUnlink={() => void doUnlink()}
								onApplyDrift={(d) => void applyDrift(d)}
							/>
							{registry && (
								<SkillRefsSection
									host={refsHost}
									content={draft.body}
									registry={registry}
									storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
								/>
							)}
						</>
					}
				/>
			</div>

			{/* Raised by the navigation guard for any in-app exit while the draft
			    is dirty — a reference row/⌘-click included, since both route
			    through the same guarded navigator. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Leave without saving?"
				body={`${draft.agentName || name} has unsaved changes. Leaving discards them.`}
				confirmLabel="Leave"
				cancelLabel="Stay"
				tone="danger"
			/>
		</>
	);
}
