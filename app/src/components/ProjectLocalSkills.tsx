import { useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";

export interface ProjectSkillCandidate {
	name: string;
	project: string;
	path: string;
	category: "NEW" | "INVALID_NAME" | string;
	version?: string | null;
	description: string;
	reason?: string | null;
}

export interface ProjectLocalSkillsProps {
	candidates: ProjectSkillCandidate[];
	/** Adopt a NEW candidate. Resolves on success; rejects on failure. */
	onAdopt: (candidate: ProjectSkillCandidate) => Promise<void>;
}

/**
 * Surfaces project-local skill candidates that the hub has DETECTED but not
 * adopted (hand-authored `.claude/skills/<name>/` dirs). NEW candidates offer a
 * one-click Adopt; INVALID_NAME candidates are read-only with their reason.
 * Never auto-adopts. Renders nothing when the list is empty (the parent already
 * gates on this, but we double-guard).
 */
export function ProjectLocalSkills({
	candidates,
	onAdopt,
}: ProjectLocalSkillsProps) {
	const [pending, setPending] = useState<Set<string>>(() => new Set());

	if (candidates.length === 0) return null;

	async function adopt(cand: ProjectSkillCandidate) {
		if (pending.has(cand.name)) return;
		setPending((cur) => new Set(cur).add(cand.name));
		try {
			await onAdopt(cand);
		} finally {
			setPending((cur) => {
				const next = new Set(cur);
				next.delete(cand.name);
				return next;
			});
		}
	}

	return (
		<section
			className="loadout-section"
			aria-label="Detected local skills"
			data-testid="project-local-skills"
		>
			<h3>
				<Icon name="bolt" size={14} />
				<span style={{ whiteSpace: "nowrap" }}>Detected local skills</span>
				<span className="count">{candidates.length}</span>
				<span className="stretch" />
				<span
					style={{
						color: "var(--fg-dim)",
						fontSize: 11,
						fontFamily: "var(--font-mono)",
					}}
				>
					hand-authored · not yet adopted
				</span>
			</h3>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 8,
				}}
			>
				{candidates.map((cand) => {
					const isInvalid = cand.category === "INVALID_NAME";
					const isPending = pending.has(cand.name);
					return (
						<div
							key={`${cand.category}:${cand.name}:${cand.path}`}
							className="detected-skill-row"
							data-category={cand.category}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 12,
								padding: "10px 12px",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-sm)",
								background: "var(--bg-1)",
							}}
						>
							<div style={{ minWidth: 0, flex: 1 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
									}}
								>
									<span
										style={{
											fontFamily: "var(--font-mono)",
											fontSize: 13,
											color: "var(--fg-strong)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{cand.name}
									</span>
									{isInvalid ? (
										<Tag color="var(--red)" size="sm">
											INVALID NAME
										</Tag>
									) : (
										<Tag color="var(--green)" size="sm">
											NEW
										</Tag>
									)}
									{cand.version && (
										<span
											className="text-dim text-mono"
											style={{ fontSize: 10.5 }}
										>
											v{cand.version}
										</span>
									)}
								</div>
								<p
									style={{
										margin: "4px 0 0",
										fontSize: 11.5,
										color: "var(--fg-mute)",
									}}
								>
									{isInvalid
										? (cand.reason ??
											"Folder name is not a valid skill slug.")
										: cand.description || "No description provided."}
								</p>
							</div>
							{!isInvalid && (
								<Button
									variant="primary"
									size="sm"
									icon={isPending ? undefined : "plus"}
									disabled={isPending}
									onClick={() => void adopt(cand)}
								>
									{isPending ? "Adopting…" : "Adopt"}
								</Button>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
