import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	subagentKeys,
	useSaveSubagent,
	useSkillUsage,
} from "@/hooks/useSubagents";
import {
	attachableSkills,
	listSubagents,
	provisionSkill,
	showSubagent,
	type AttachableSkill,
	type NeedsProvisioning,
	type SubagentHarness,
	type SubagentListItem,
	type SubagentSavePayload,
	type SubagentSaveResult,
	type SubagentScope,
} from "@/lib/subagents";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { ProvisionPanel } from "@/components/subagents/ProvisionPanel";

interface SkillPreloadedByProps {
	skillName: string;
}

/** One candidate target in the attach-from-skill picker. */
interface AgentTarget {
	harness: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	name: string;
	/** Whether THIS skill already resolves + is invocable in the agent's scope. */
	attachable: boolean;
	/** Registry-known but unresolved here — attaching triggers D5 provisioning. */
	provisionable: boolean;
	/** Reason it isn't attachable (for the disabled hint). */
	reason: string;
	/** Whether the agent already preloads this skill. */
	already: boolean;
}

/** Dedupe the `needs_provisioning` details out of a blocked save's errors. */
function collectNeeds(errs: { needs_provisioning?: NeedsProvisioning }[]): NeedsProvisioning[] {
	const items: NeedsProvisioning[] = [];
	const seen = new Set<string>();
	for (const e of errs) {
		const np = e.needs_provisioning;
		if (np && !seen.has(np.skill)) {
			seen.add(np.skill);
			items.push(np);
		}
	}
	return items;
}

/**
 * Skill-side surface (D6): "Preloaded by N sub-agents" + an "Attach to
 * sub-agent…" picker. Mirrors the SkillEditor side-panel "Equipped on" pattern.
 * The picker spans every agent-capable harness (Claude user+project, Codex user
 * — project scope is trust-gated to a later wave), and on selection appends this
 * skill to the agent's `safe.skills` via the validated save path. When the skill
 * is registry-known but does not yet resolve for the target, the save returns a
 * `needs_provisioning` detail and we run the D5 consequence → provision → re-save
 * loop before writing the preload reference.
 */
export function SkillPreloadedBy({ skillName }: SkillPreloadedByProps) {
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry } = useRegistry();
	const { data: usage } = useSkillUsage();
	const saveMut = useSaveSubagent();
	const harnesses = useHarnesses();
	const [pickerOpen, setPickerOpen] = useState(false);

	// ─── D5 provisioning prompt state (one attach in flight at a time) ──────────
	const [prov, setProv] = useState<{
		target: AgentTarget;
		payload: SubagentSavePayload;
		items: NeedsProvisioning[];
	} | null>(null);
	const [provBusy, setProvBusy] = useState(false);
	const [provError, setProvError] = useState<string | null>(null);
	const [provWiden, setProvWiden] = useState<{
		skill: string;
		affinity: string[];
	} | null>(null);

	const projectNames = useMemo(
		() => (registry ? Object.keys(registry.projects) : []),
		[registry],
	);

	// The agents that already preload this skill (reverse index).
	const preloaders = usage?.[skillName] ?? [];

	// Agent-capable, installed harnesses (falls back to claude-code if the harness
	// scan hasn't populated yet, keeping the shipped Claude-only behavior intact).
	const agentHarnesses = useMemo<SubagentHarness[]>(() => {
		const ids = (harnesses ?? [])
			.filter((h) => h.agents?.supported && h.installed)
			.map((h) => h.id as SubagentHarness);
		return ids.length ? ids : ["claude-code"];
	}, [harnesses]);

	// Build the (harness, scope, project) set the picker queries. Codex ships user
	// scope only in this wave (project scope is trust-gated → later).
	const scopeSpecs = useMemo(
		() => {
			const specs: Array<{
				harness: SubagentHarness;
				scope: SubagentScope;
				project: string | null;
			}> = [];
			for (const h of agentHarnesses) {
				specs.push({ harness: h, scope: "user", project: null });
				if (h === "claude-code") {
					for (const p of projectNames)
						specs.push({ harness: h, scope: "project", project: p });
				}
			}
			return specs;
		},
		[agentHarnesses, projectNames],
	);

	// Query each spec's agent list + attachable-skills, only while the picker is
	// open (keeps the skill editor cheap until the user asks to attach).
	const listQueries = useQueries({
		queries: scopeSpecs.map((s) => ({
			queryKey: subagentKeys.list(s.scope, s.project, s.harness),
			queryFn: () => listSubagents(s.scope, s.project, s.harness),
			enabled: pickerOpen,
		})),
	});
	const attachQueries = useQueries({
		queries: scopeSpecs.map((s) => ({
			queryKey: subagentKeys.attachable(s.scope, s.project, s.harness),
			queryFn: () => attachableSkills(s.scope, s.project, s.harness),
			enabled: pickerOpen,
		})),
	});

	const inRegistry = !!registry?.skills?.[skillName];

	const targets: AgentTarget[] = useMemo(() => {
		const out: AgentTarget[] = [];
		scopeSpecs.forEach((spec, i) => {
			const list = listQueries[i]?.data;
			const attach = attachQueries[i]?.data as AttachableSkill[] | undefined;
			const entry = attach?.find((a) => a.name === skillName);
			const attachable = entry?.attachable ?? false;
			const invocable = entry?.invocable ?? true;
			// Registry-known + invocable but not currently resolved → attaching
			// triggers the D5 provisioning flow rather than a dead preload. Scoped
			// to USER targets (make-global), which is the cross-harness scenario
			// this surface is about; project-scope non-resolving skills keep the
			// existing "not attachable" blocking (resolve them from the project's
			// own Sub-Agents tab / agent editor instead).
			const provisionable =
				spec.scope === "user" && !attachable && inRegistry && invocable;
			const reason =
				entry?.reason ||
				(entry ? "" : "This skill does not resolve in this scope.");
			(list?.agents ?? []).forEach((a: SubagentListItem) => {
				out.push({
					harness: spec.harness,
					scope: spec.scope,
					project: spec.project,
					name: a.name,
					attachable,
					provisionable,
					reason,
					already: a.skills.includes(skillName),
				});
			});
		});
		return out;
	}, [scopeSpecs, listQueries, attachQueries, skillName, inRegistry]);

	function goToAgent(
		scope: SubagentScope,
		project: string | null,
		harness: SubagentHarness = "claude-code",
	) {
		if (scope === "project" && project) {
			navigate(`/project/${encodeURIComponent(project)}?view=subagents`);
		} else {
			navigate(`/harness/${harness}`);
		}
	}

	const closePicker = useCallback(() => {
		setPickerOpen(false);
		setProv(null);
		setProvError(null);
		setProvWiden(null);
	}, []);

	function announceSaved(res: SubagentSaveResult, t: AgentTarget) {
		if (res.warnings?.length) {
			toast.push({
				kind: "info",
				title: `Attached to ${t.name}`,
				body: `${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"}.`,
			});
		} else {
			toast.success(`Attached to ${t.name}`);
		}
		closePicker();
	}

	// Save the appended preload reference. On a block whose errors carry
	// `needs_provisioning`, raise the consequence prompt instead of a bare error.
	const runAttachSave = useCallback(
		async (t: AgentTarget, payload: SubagentSavePayload) => {
			const res = await saveMut.mutateAsync(payload);
			if (res.ok) {
				announceSaved(res, t);
				return;
			}
			const errs = res.errors ?? [];
			const items = collectNeeds(errs);
			if (items.length) {
				setProvError(null);
				setProvWiden(null);
				setProv({ target: t, payload, items });
			} else {
				toast.error(
					"Attach blocked",
					errs.map((e) => e.message).join("; ") || "Validation failed.",
				);
			}
		},
		// announceSaved/toast are stable enough; saveMut is the real dep.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[saveMut, skillName],
	);

	async function attach(t: AgentTarget) {
		if (saveMut.isPending || provBusy) return;
		try {
			const show = await showSubagent(t.scope, t.name, t.project, t.harness);
			if (!show.exists) {
				toast.error("Couldn't attach skill", `${t.name} no longer exists.`);
				return;
			}
			if (show.safe.skills.includes(skillName)) {
				toast.info(`${t.name} already preloads ${skillName}`);
				closePicker();
				return;
			}
			const payload: SubagentSavePayload = {
				...(t.harness !== "claude-code" ? { harness: t.harness } : {}),
				scope: t.scope,
				project: t.project,
				original_name: t.name,
				safe: { ...show.safe, skills: [...show.safe.skills, skillName] },
				advanced_yaml: show.advanced_yaml,
				body: show.body,
			};
			await runAttachSave(t, payload);
		} catch (e) {
			toast.error("Couldn't attach skill", String(e));
		}
	}

	// Confirm the consequence prompt: provision each skill for the target's
	// harness/scope, then re-save the captured payload. Affinity refusal swaps in
	// a distinct widen confirm; any other refusal (e.g. remote quarantine) is a
	// dead stop with no retry.
	const confirmProv = useCallback(
		async (widenSkill?: string) => {
			if (!prov || provBusy) return;
			const t = prov.target;
			setProvBusy(true);
			setProvError(null);
			try {
				for (const item of prov.items) {
					const isGlobal = item.scope_fix === "make-global";
					const res = await provisionSkill({
						skill: item.skill,
						global: isGlobal,
						project: isGlobal ? null : t.project,
						harnessId: t.harness,
						widenAffinity: widenSkill === item.skill,
					});
					if (!res.ok) {
						if (res.widen_available) {
							setProvWiden({ skill: item.skill, affinity: res.affinity ?? [] });
						} else {
							setProvError(res.error ?? "Provisioning failed.");
						}
						return;
					}
				}
				setProvWiden(null);
				const res = await saveMut.mutateAsync(prov.payload);
				if (res.ok) {
					announceSaved(res, t);
					return;
				}
				const errs = res.errors ?? [];
				const items = collectNeeds(errs);
				if (items.length) {
					setProv({ ...prov, items });
				} else {
					setProv(null);
					toast.error(
						"Attach blocked",
						errs.map((e) => e.message).join("; ") || "Validation failed.",
					);
				}
			} catch (e) {
				setProvError(String(e));
			} finally {
				setProvBusy(false);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[prov, provBusy, saveMut],
	);

	const cancelProv = useCallback(() => {
		setProv(null);
		setProvError(null);
		setProvWiden(null);
	}, []);

	return (
		<div className="side-panel-block">
			<h4>
				Preloaded by{" "}
				<span style={{ color: "var(--fg-dim)" }}>· {preloaders.length}</span>
			</h4>
			<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
				{preloaders.length === 0 ? (
					<span className="text-dim text-mono" style={{ fontSize: 11 }}>
						Not preloaded by any sub-agent
					</span>
				) : (
					preloaders.map((p) => {
						// Entries carry their owning harness; absent ⇒ claude-code
						// (pre-multi-harness payloads).
						const ph: SubagentHarness = p.harness ?? "claude-code";
						return (
							<button
								key={`${ph}:${p.scope}:${p.project ?? ""}:${p.agent}`}
								type="button"
								className="equip-row skill-preload-row"
								onClick={() => goToAgent(p.scope, p.project, ph)}
								title={`Open ${p.agent} (${harnessLabel(ph)} · ${p.scope === "project" ? `project · ${p.project}` : "user"})`}
							>
								<HarnessGlyph
									id={ph}
									label={harnessLabel(ph)}
									size={14}
									decorative
								/>
								<span className="name text-mono">{p.agent}</span>
								<span className="state" data-on="true">
									{p.scope === "project" ? p.project : "USER"}
								</span>
							</button>
						);
					})
				)}
			</div>

			<div style={{ marginTop: 10 }}>
				{pickerOpen ? (
					<div className="skill-attach-picker">
						<div className="skill-attach-picker-head">
							<span className="text-mono text-dim" style={{ fontSize: 11 }}>
								Attach to sub-agent
							</span>
							<button
								type="button"
								className="skill-attach-close"
								aria-label="Close picker"
								onClick={closePicker}
							>
								<Icon name="x" size={11} />
							</button>
						</div>

						{/* D5 consequence prompt (blocks the list while resolving one attach). */}
						{prov && (
							<ProvisionPanel
								items={prov.items}
								harness={prov.target.harness}
								busy={provBusy}
								error={provError}
								widen={provWiden}
								onConfirm={confirmProv}
								onCancel={cancelProv}
							/>
						)}

						{!prov && (
							<div className="skill-attach-list">
								{targets.length === 0 ? (
									<span
										className="text-dim text-mono"
										style={{ fontSize: 11, padding: "6px 4px" }}
									>
										{listQueries.some((q) => q.isLoading)
											? "Loading agents…"
											: "No sub-agents found."}
									</span>
								) : (
									targets.map((t) => {
										const canAttach = t.attachable || t.provisionable;
										const blocked = !canAttach && !t.already;
										return (
											<button
												key={`${t.harness}:${t.scope}:${t.project ?? ""}:${t.name}`}
												type="button"
												className="skill-attach-option"
												disabled={blocked || t.already || saveMut.isPending}
												data-blocked={blocked || undefined}
												title={
													t.already
														? "Already preloads this skill"
														: t.provisionable
															? `Attach ${skillName} to ${t.name} (will make it available first)`
															: blocked
																? t.reason
																: `Add ${skillName} to ${t.name}`
												}
												onClick={() => void attach(t)}
											>
												<HarnessGlyph
													id={t.harness}
													label={harnessLabel(t.harness)}
													size={12}
													decorative
												/>
												<span className="text-mono skill-attach-name">
													{t.name}
												</span>
												<span className="skill-attach-scope text-dim">
													{t.scope === "project" ? t.project : "user"}
												</span>
												{t.already ? (
													<span className="skill-attach-tag" data-tone="ok">
														attached
													</span>
												) : t.provisionable ? (
													<span className="skill-attach-tag" data-tone="warn">
														will provision
													</span>
												) : blocked ? (
													<span className="skill-attach-tag" data-tone="warn">
														not attachable
													</span>
												) : (
													<Icon name="plus" size={11} />
												)}
											</button>
										);
									})
								)}
							</div>
						)}
					</div>
				) : (
					<Button size="sm" icon="plus" onClick={() => setPickerOpen(true)}>
						Attach to sub-agent…
					</Button>
				)}
			</div>
		</div>
	);
}
