import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { ErrorCard } from "@/components/ErrorCard";
import { InfoBanner } from "@/components/InfoBanner";
import {
	recoveryErrorMessage,
	useRecoveryFinish,
	useRecoveryStage,
	useRecoveryStatus,
} from "@/hooks/useRecovery";
import {
	RECOVERY_STAGES,
	RECOVERY_STAGE_LABELS,
	hasUnresolvedRows,
	recoveryFinishCounts,
	stageRowsResolved,
	type RecoveryStage,
	type RecoveryStatus,
} from "@/lib/recoveryContract";
import { RecoverySourcesStep } from "@/components/recovery/RecoverySourcesStep";
import { RecoveryProjectsStep } from "@/components/recovery/RecoveryProjectsStep";
import { RecoveryRemainingStep } from "@/components/recovery/RecoveryRemainingStep";
import { RecoverySyncStep } from "@/components/recovery/RecoverySyncStep";
import { useAppStore } from "@/store";

/** Wizard-visible stages — "library" is the instant before `recovery start`
 *  ran (BootstrapRestoreStep's own screen), never a step of this stepper. */
const WIZARD_STAGES: RecoveryStage[] = RECOVERY_STAGES.filter((s) => s !== "library");

function StageStep({
	status,
	active,
	focusProject,
}: {
	status: RecoveryStatus;
	active: RecoveryStage;
	focusProject: string | null;
}) {
	switch (active) {
		case "sources":
			return <RecoverySourcesStep status={status} />;
		case "projects":
			return <RecoveryProjectsStep status={status} focusProject={focusProject} />;
		case "remaining":
			return <RecoveryRemainingStep status={status} />;
		case "sync":
			return <RecoverySyncStep status={status} />;
		default:
			return null;
	}
}

/** Reopen persisted recovery without importing the snapshot again.
 * Old restored registries and explicit attachment links also reach this screen.
 * Skipped items remain available after the overall recovery is closed. */
export function RecoveryWizard() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const status = useRecoveryStatus();
	const setStage = useRecoveryStage();
	const finish = useRecoveryFinish();
	const addToast = useAppStore((s) => s.addToast);
	const [active, setActive] = useState<RecoveryStage>("sources");
	const [seededFromStatus, setSeededFromStatus] = useState(false);
	const syncAttempted = status.data?.syncCurrent === true;
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	// `?project=NAME` — the deep link a project's own "Attach directory"
	// action reopens this wizard with (ProjectWorkspace/status surfaces own
	// that button; this screen only has to land on the right project once it
	// arrives). Read once: a later status refetch must not keep re-focusing
	// a row the user has already moved away from.
	const focusProject = searchParams.get("project");
	const requestedStage = searchParams.get("stage") as RecoveryStage | null;

	// Seed the active step from the persisted stage exactly once per load — a
	// later status refetch (e.g. after a source finishes) must not yank the
	// user back to whatever stage they started on. A `?project=` deep link
	// always wins: it names an explicit destination the caller asked for.
	useEffect(() => {
		if (seededFromStatus || !status.data) return;
		if (focusProject) {
			setActive("projects");
		} else if (requestedStage && WIZARD_STAGES.includes(requestedStage)) {
			setActive(requestedStage);
		} else {
			const persisted = status.data.stage;
			if (persisted && persisted !== "library" && WIZARD_STAGES.includes(persisted)) {
				setActive(persisted);
			}
		}
		setSeededFromStatus(true);
	}, [seededFromStatus, status.data, focusProject, requestedStage]);

	// Move focus to the step heading on every stage change, so a screen-reader
	// user gets the same "you're on a new step" signal a sighted user gets
	// from the stepper's highlight (experience-review: "announce material
	// asynchronous results").
	useEffect(() => {
		headingRef.current?.focus();
	}, [active]);

	async function goTo(stage: RecoveryStage) {
		setActive(stage);
		try {
			await setStage.mutateAsync(stage);
		} catch {
			// Non-fatal: the stepper still moves locally even if the persisted
			// stage write fails — the user can retry navigation.
		}
	}

	function stepIndex(stage: RecoveryStage): number {
		return WIZARD_STAGES.indexOf(stage);
	}

	function goBack() {
		const i = stepIndex(active);
		if (i > 0) void goTo(WIZARD_STAGES[i - 1]);
	}

	function goNext() {
		const i = stepIndex(active);
		if (i < WIZARD_STAGES.length - 1) void goTo(WIZARD_STAGES[i + 1]);
	}

	async function runFinish(defer = false) {
		try {
			await finish.mutateAsync(defer);
			if (defer) navigate("/");
			addToast("success", defer ? "Setup deferred. Resume from Backup when ready." : "Recovery finished");
		} catch (e) {
			addToast("error", `Couldn't finish recovery — ${recoveryErrorMessage(e)}`);
		}
	}

	if (status.isLoading) {
		return (
			<>
				<ScreenHeader icon="sync" title="Finish setup" />
				<div className="main-body recovery-screen-body">
					<p>Reading recovery status…</p>
				</div>
			</>
		);
	}

	if (status.isError || !status.data) {
		return (
			<>
				<ScreenHeader icon="sync" title="Finish setup" />
				<div className="main-body recovery-screen-body">
					<ErrorCard
						title="Cannot read recovery status"
						description={recoveryErrorMessage(status.error)}
						actions={<Button onClick={() => void status.refetch()}>Retry</Button>}
					/>
				</div>
			</>
		);
	}

	const data = status.data;
	const previewOnly = searchParams.get("restoreRecovery") === "1" && !data.operationId;
	// Keep older restores and explicit recovery links reachable without a progress record.
	const hasRecord = data.operationId !== null || data.needsRecovery || !!data.restoredFrom || previewOnly || !!focusProject || (requestedStage === "sources" && data.sources.some((row) => !row.healthy));

	if (!hasRecord) {
		return (
			<>
				<ScreenHeader icon="sync" title="Finish setup" />
				<div className="main-body recovery-screen-body">
					<InfoBanner icon="check">
						Nothing to recover here — this machine has no restore in progress.
					</InfoBanner>
				</div>
			</>
		);
	}

	const counts = recoveryFinishCounts(data);
	const blockedByUnresolved = hasUnresolvedRows(data);
	const blockedBySync = !syncAttempted;
	const syncResult = data.syncResult;
	const syncFailed = !!syncResult && (
		!syncResult.ok ||
		syncResult.counts.failed > 0 ||
		syncResult.globalFailures.length > 0 ||
		Object.keys(syncResult.projectFailures).length > 0 ||
		syncResult.error !== null
	);
	const blockedBySyncFailure = syncAttempted && syncFailed;
	const setupStagesResolved = WIZARD_STAGES
		.filter((stage) => stage !== "sync")
		.every((stage) => stageRowsResolved(data, stage));
	const canFinish = !blockedByUnresolved && !blockedBySync && !blockedBySyncFailure && !finish.isPending;
	const finishReason = blockedByUnresolved
		? "Every source and project needs an outcome — resolve or skip what's left"
		: blockedBySync
			? "Run a sync at least once before finishing"
			: blockedBySyncFailure
				? "Resolve the sync failures or run sync again before finishing"
				: undefined;
	const allResolved = counts.failed === 0 && counts.skipped === 0;

	return (
		<>
			<ScreenHeader
				icon="sync"
				title="Finish setup"
				subline={
					data.restoredFrom ? `Restored from ${data.restoredFrom}` : "Resume the restore from earlier"
				}
			/>
			<div className="main-body recovery-screen-body">
				<div className="recovery-lede">
					<p>
						Recover what a snapshot can't carry on its own: skill sources, project checkouts, and
						anything local-only. Skipping is always safe — nothing loses its registration or
						equipment.
					</p>
				</div>

				{data.dismissed && (
					<InfoBanner icon="info" className="recovery-step-lede">
						You closed this recovery earlier. Attach or retry the remaining items below.
					</InfoBanner>
				)}

				<nav className="backup-journey" aria-label="Recovery steps">
					<ul className="backup-stages" role="tablist">
						{WIZARD_STAGES.map((stage, i) => {
							const resolved =
								stage === "sync"
									? syncAttempted && !syncFailed && setupStagesResolved
									: stageRowsResolved(data, stage);
							const state: "done" | "current" | "todo" =
								stage === active ? "current" : resolved ? "done" : "todo";
							return (
								<li key={stage} className="backup-stage" data-state={state}>
									<div className="backup-stage-rail">
										<div className="backup-stage-pip" aria-hidden="true">
											{state === "done" ? "✓" : i + 1}
										</div>
									</div>
									<div className="backup-stage-body">
										<div className="backup-stage-head">
											<button
												type="button"
												role="tab"
												aria-selected={stage === active}
												className="recovery-picker-tab"
												onClick={() => void goTo(stage)}
												data-testid={`recovery-stage-tab-${stage}`}
											>
												{RECOVERY_STAGE_LABELS[stage]}
											</button>
										</div>
									</div>
								</li>
							);
						})}
					</ul>
				</nav>

				<h2
					ref={headingRef}
					tabIndex={-1}
					className="recovery-step-heading"
					data-testid="recovery-step-heading"
				>
					{RECOVERY_STAGE_LABELS[active]}
				</h2>

				<StageStep
					status={data}
					active={active}
					focusProject={focusProject}
				/>

				<div className="backup-stage-content recovery-wizard-nav" style={{ marginTop: 20 }}>
					<Button variant="ghost" onClick={() => void runFinish(true)} busy={finish.isPending}
						disabled={[...data.projects, ...data.sources, ...data.localSources].some((row) => row.status === "running")}
						data-testid="recovery-defer-btn">Finish later</Button>
					<Button
						variant="ghost"
						onClick={goBack}
						disabled={stepIndex(active) === 0}
						data-testid="recovery-nav-back"
					>
						Back
					</Button>
					{stepIndex(active) < WIZARD_STAGES.length - 1 ? (
						<Button onClick={goNext} data-testid="recovery-nav-next">
							Continue
						</Button>
					) : (
						<Button
							variant="primary"
							busy={finish.isPending}
							disabled={!canFinish}
							disabledReason={finishReason}
							onClick={() => void runFinish()}
							data-testid="recovery-finish-btn"
						>
							{allResolved ? "Finish" : "Finish with skipped items"}
						</Button>
					)}
				</div>
			</div>
		</>
	);
}
