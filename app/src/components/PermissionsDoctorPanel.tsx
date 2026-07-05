import { useMemo, useState } from "react";
import { Tag } from "./Tag";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { RiskBadge } from "./RiskBadge";
import { HarnessGlyph, HarnessIconGroup } from "./harness/HarnessGlyph";
import { harnessLabel } from "./harness/harnessRegistry";
import type { DoctorFinding } from "@/types/permissions";

export interface PermissionsDoctorPanelProps {
	open: boolean;
	findings: DoctorFinding[];
	loading?: boolean;
	error?: string | null;
	onClose: () => void;
	/** Click-through: scroll & focus the offending row. Detail is the rule
	 *  pattern (or hook identifier). */
	onJumpToFinding?: (finding: DoctorFinding) => void;
}

type DoctorFindingCompat = DoctorFinding & {
	/** Legacy/raw CLI shape from `hub permissions doctor --json`. */
	scope?: string;
	harness?: string;
};

interface FindingGroup {
	key: string;
	code: string;
	severity: DoctorFinding["severity"];
	explanation: string;
	detail: string;
	hits: DoctorFindingCompat[];
	scopes: string[];
	harnesses: string[];
}

export function PermissionsDoctorPanel({
	open,
	findings,
	loading,
	error,
	onClose,
	onJumpToFinding,
}: PermissionsDoctorPanelProps) {
	const [copied, setCopied] = useState(false);
	const compatibleFindings = findings as DoctorFindingCompat[];
	const groups = useMemo(
		() => groupFindings(compatibleFindings),
		[compatibleFindings],
	);
	const dangerCount = compatibleFindings.filter(
		(f) => f.severity === "danger",
	).length;
	const warningCount = compatibleFindings.length - dangerCount;
	const affectedScopes = new Set(compatibleFindings.map(scopeText)).size;
	const fullReport = useMemo(
		() => ({ findings: compatibleFindings, danger_count: dangerCount }),
		[compatibleFindings, dangerCount],
	);

	const copyFullReport = async () => {
		await navigator.clipboard.writeText(JSON.stringify(fullReport, null, 2));
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	};

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="Permissions doctor"
			width={760}
			className="doctor-panel"
			footer={
				<>
					{!loading && !error && findings.length > 0 && (
						<Button
							variant="soft"
							icon="copy"
							onClick={() => void copyFullReport()}
							title="Copy the complete doctor JSON report"
						>
							{copied ? "Copied" : "Copy full JSON"}
						</Button>
					)}
					<Button variant="ghost" onClick={onClose}>
						Close
					</Button>
				</>
			}
		>
			{!loading && !error && findings.length > 0 && (
				<p className="doctor-panel-lede">
					Findings are grouped by unique risk so repeated inherited
					permissions do not flood the dialog. Copy the full JSON when you
					need exact diagnostics.
				</p>
			)}


				{loading && (
					<div style={{ color: "var(--fg-mute)", fontSize: 12 }}>
						Running checks…
					</div>
				)}
				{error && (
					<div
						role="alert"
						style={{
							padding: 10,
							borderRadius: "var(--radius)",
							border: "1px solid var(--red)",
							color: "var(--red)",
							fontSize: 12,
						}}
					>
						{error}
					</div>
				)}

				{!loading && !error && findings.length === 0 && (
					<div
						style={{
							padding: 24,
							textAlign: "center",
							color: "var(--green)",
							fontSize: 13,
						}}
					>
						Nothing flagged. All checks pass.
					</div>
				)}

				{!loading && !error && findings.length > 0 && (
					<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
								gap: 8,
							}}
						>
							<SummaryCard label="Findings" value={findings.length} />
							<SummaryCard
								label="Danger"
								value={dangerCount}
								color="var(--red)"
							/>
							<SummaryCard
								label="Warnings"
								value={warningCount}
								color="var(--amber)"
							/>
							<SummaryCard label="Scopes" value={affectedScopes} />
						</div>

						<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
							{groups.map((group) => (
								<div
									key={group.key}
									style={{
										borderRadius: "var(--radius)",
										border: "1px solid var(--border)",
										background: "var(--bg-2)",
										overflow: "hidden",
									}}
								>
									<button
										type="button"
										className="doctor-finding-row"
										onClick={() => onJumpToFinding?.(group.hits[0])}
										style={{
											width: "100%",
											display: "grid",
											gridTemplateColumns: "auto 1fr auto",
											gap: 10,
											padding: "10px 12px",
											border: 0,
											background: "transparent",
											textAlign: "left",
											cursor: "pointer",
											alignItems: "center",
											fontFamily: "var(--font-sans)",
											color: "var(--fg-strong)",
										}}
									>
										<RiskBadge
											code={group.code}
											severity={group.severity}
											explanation={group.explanation}
											detail={group.detail}
										/>
										<div style={{ fontSize: 12, minWidth: 0 }}>
											<div style={{ color: "var(--fg-strong)" }}>
												{group.explanation}
											</div>
											{group.detail && (
												<div
													style={{
														fontFamily: "var(--font-mono)",
														color: "var(--fg-mute)",
														fontSize: 11,
														marginTop: 2,
													}}
												>
													{group.detail}
												</div>
											)}
											<div
												style={{
													color: "var(--fg-dim)",
													fontSize: 11,
													marginTop: 4,
													display: "flex",
													alignItems: "center",
													gap: 5,
													flexWrap: "wrap",
												}}
											>
												{summarizeScopes(group.scopes)} ·{" "}
												{group.harnesses.length > 0 && (
													<HarnessIconGroup
														ids={group.harnesses}
														size={14}
														maxVisible={3}
													/>
												)}
												<span>{summarizeHarnesses(group.harnesses)}</span>
											</div>
										</div>
										<Tag
											color="var(--violet)"
											style={{ fontFamily: "var(--font-mono)" }}
										>
											{group.hits.length} hit
											{group.hits.length === 1 ? "" : "s"}
										</Tag>
									</button>

									{group.hits.length > 1 && (
										<details
											style={{
												borderTop: "1px solid var(--border)",
												padding: "8px 12px 10px",
												color: "var(--fg-mute)",
												fontSize: 11,
											}}
										>
											<summary
												style={{
													cursor: "pointer",
													color: "var(--fg-mid)",
													fontFamily: "var(--font-mono)",
												}}
											>
												Show affected harness/scope pairs
											</summary>
											<div
												style={{
													display: "flex",
													flexWrap: "wrap",
													gap: 6,
													marginTop: 8,
												}}
											>
												{group.hits.map((hit, i) => (
													<Tag
														key={`${scopeText(hit)}:${harnessText(hit)}:${i}`}
														color={
															scopeText(hit) === "global"
																? "var(--violet)"
																: "var(--amber)"
														}
														style={{
															fontFamily: "var(--font-mono)",
															display: "inline-flex",
															alignItems: "center",
															gap: 5,
														}}
													>
														{scopeText(hit)} ·{" "}
														{harnessText(hit) ? (
															<>
																<HarnessGlyph
																	id={harnessText(hit)!}
																	label={harnessLabel(harnessText(hit)!)}
																	size={14}
																	decorative
																/>
																{harnessLabel(harnessText(hit)!)}
															</>
														) : (
															"all"
														)}
													</Tag>
												))}
											</div>
										</details>
									)}
								</div>
							))}
						</div>
					</div>
				)}
		</Modal>
	);
}

function SummaryCard({
	label,
	value,
	color = "var(--fg-strong)",
}: {
	label: string;
	value: number;
	color?: string;
}) {
	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius)",
				background: "var(--bg-2)",
				padding: "10px 12px",
			}}
		>
			<div
				style={{
					color: "var(--fg-mute)",
					fontSize: 10,
					letterSpacing: "0.08em",
					textTransform: "uppercase",
					fontFamily: "var(--font-mono)",
				}}
			>
				{label}
			</div>
			<div
				style={{
					color,
					fontSize: 18,
					marginTop: 3,
					fontFamily: "var(--font-mono)",
				}}
			>
				{value}
			</div>
		</div>
	);
}

function groupFindings(findings: DoctorFindingCompat[]): FindingGroup[] {
	const groups = new Map<string, FindingGroup>();
	for (const finding of findings) {
		const key = [
			finding.severity,
			finding.code,
			finding.detail,
			finding.explanation,
		].join("\u0000");
		const existing = groups.get(key);
		if (existing) {
			existing.hits.push(finding);
			existing.scopes = addUnique(existing.scopes, scopeText(finding));
			existing.harnesses = addUnique(existing.harnesses, harnessText(finding));
			continue;
		}
		const harness = harnessText(finding);
		groups.set(key, {
			key,
			code: finding.code,
			severity: finding.severity,
			explanation: finding.explanation,
			detail: finding.detail,
			hits: [finding],
			scopes: [scopeText(finding)],
			harnesses: harness ? [harness] : [],
		});
	}
	return [...groups.values()].sort((a, b) => {
		if (a.severity !== b.severity) return a.severity === "danger" ? -1 : 1;
		return b.hits.length - a.hits.length;
	});
}

function addUnique(values: string[], next: string | null): string[] {
	if (!next || values.includes(next)) return values;
	return [...values, next];
}

function scopeText(finding: DoctorFindingCompat): string {
	if (finding.scope) return finding.scope;
	return finding.scope_kind === "global"
		? "global"
		: `project:${finding.scope_label}`;
}

function harnessText(finding: DoctorFindingCompat): string | null {
	return finding.harness_id ?? finding.harness ?? null;
}

function summarizeScopes(scopes: string[]): string {
	const hasGlobal = scopes.includes("global");
	const projects = scopes.filter((s) => s.startsWith("project:"));
	if (hasGlobal && projects.length > 1)
		return `global + ${projects.length} projects`;
	if (hasGlobal && projects.length === 1) return `global + ${projects[0]}`;
	if (scopes.length <= 3) return scopes.join(", ");
	return `${scopes.length} scopes`;
}

function summarizeHarnesses(values: string[]): string {
	if (values.length === 0) return "all harnesses";
	const labels = values.map(harnessLabel);
	if (values.length <= 3) return labels.join(", ");
	return `${values.length} harnesses`;
}
