import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { Button } from "./Button";
import { Tag } from "./Tag";
import { harnessTint, harnessDisplayLabel } from "./harness/harnessRegistry";
import type {
	ImportApplyResult,
	ImportCandidateSet,
	ImportDecision,
	RuleKind,
	Scope,
} from "@/types/permissions";

export interface ImportMergeDialogProps {
	open: boolean;
	scope: Scope;
	onClose: () => void;
	onApplied: () => void;
	harnessLabels?: Record<string, string>;
}

type MergedChoice = "import" | "keep" | "drop";
// Conflict choice: a specific kind, "both" (keep each with affinity), keep, or drop.
type ConflictChoice = RuleKind | "both" | "keep" | "drop";

/**
 * Cross-harness import/merge wizard (D11/D12). Lists discovered candidates with
 * per-rule import/keep/drop, surfaces divergent-decision conflicts (never
 * auto-picked), flags un-importable Codex shapes read-only, and warns that
 * import/drop MOVE rules out of the native files (backup-first).
 */
export function ImportMergeDialog({
	open,
	scope,
	onClose,
	onApplied,
	harnessLabels,
}: ImportMergeDialogProps) {
	const [data, setData] = useState<ImportCandidateSet | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [mergedChoice, setMergedChoice] = useState<Record<string, MergedChoice>>(
		{},
	);
	const [conflictChoice, setConflictChoice] = useState<
		Record<string, ConflictChoice>
	>({});

	useEffect(() => {
		if (!open) return;
		setLoading(true);
		setError(null);
		invoke<ImportCandidateSet>("permissions_import_candidates", { scope })
			.then((d) => {
				setData(d);
				const md: Record<string, MergedChoice> = {};
				for (const m of d.merged) md[m.pattern] = "import";
				setMergedChoice(md);
				const cd: Record<string, ConflictChoice> = {};
				for (const c of d.conflicts) cd[c.pattern] = "both";
				setConflictChoice(cd);
			})
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [open, scope]);

	if (!open) return null;

	const buildDecisions = (): ImportDecision[] => {
		if (!data) return [];
		const out: ImportDecision[] = [];
		for (const m of data.merged) {
			const action = mergedChoice[m.pattern] ?? "import";
			out.push({ pattern: m.pattern, action, kind: m.kind });
		}
		for (const c of data.conflicts) {
			const choice = conflictChoice[c.pattern] ?? "both";
			if (choice === "both") {
				for (const [kind, harns] of Object.entries(c.options)) {
					out.push({
						pattern: c.pattern,
						action: "import",
						kind: kind as RuleKind,
						harnesses: harns,
					});
				}
			} else if (choice === "keep") {
				out.push({ pattern: c.pattern, action: "keep" });
			} else if (choice === "drop") {
				out.push({ pattern: c.pattern, action: "drop" });
			} else {
				out.push({
					pattern: c.pattern,
					action: "import",
					kind: choice as RuleKind,
				});
			}
		}
		return out;
	};

	async function apply() {
		setBusy(true);
		setError(null);
		try {
			await invoke<ImportApplyResult>("permissions_import_apply", {
				scope,
				decisions: buildDecisions(),
			});
			onApplied();
			onClose();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	const nothing =
		data &&
		data.merged.length === 0 &&
		data.conflicts.length === 0 &&
		data.un_importable.length === 0;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="import-merge-title"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.6)",
				display: "grid",
				placeItems: "center",
				zIndex: 1000,
			}}
		>
			<div
				style={{
					width: 760,
					maxHeight: "82vh",
					overflow: "auto",
					background: "var(--bg-1)",
					border: "1px solid var(--bg-3)",
					borderRadius: 12,
					padding: 24,
				}}
			>
				<h2
					id="import-merge-title"
					style={{
						margin: 0,
						marginBottom: 6,
						fontSize: 16,
						color: "var(--fg-strong)",
						fontFamily: "var(--font-sans)",
					}}
				>
					Import existing rules
				</h2>
				<p
					style={{
						margin: 0,
						marginBottom: 16,
						color: "var(--fg-mid)",
						fontSize: 13,
						fontFamily: "var(--font-sans)",
					}}
				>
					Rules discovered in your native config files. Importing or dropping a
					Codex rule <strong>moves it out</strong> of <code>default.rules</code>{" "}
					(backup-first) so it won't linger as a ghost.
				</p>

				{loading && <div style={{ color: "var(--fg-mute)" }}>Discovering…</div>}
				{nothing && (
					<div style={{ color: "var(--fg-mute)", fontSize: 13 }}>
						Nothing to import.
					</div>
				)}

				{data && data.merged.length > 0 && (
					<section style={{ marginBottom: 18 }}>
						<SectionLabel>Importable</SectionLabel>
						{data.merged.map((m) => (
							<div
								key={m.pattern}
								data-testid="import-merged-row"
								style={rowStyle}
							>
								<span style={{ color: "var(--fg-mid)", width: 56 }}>
									{m.kind}
								</span>
								<code style={{ flex: 1, color: "var(--fg-strong)" }}>
									{m.pattern}
								</code>
								<span style={{ display: "flex", gap: 4 }}>
									{m.sources.map((s) => (
										<Tag key={s.harness} color={harnessTint(s.harness)}>
											{harnessDisplayLabel(s.harness, harnessLabels)}
										</Tag>
									))}
								</span>
								<ChoiceButtons
									value={mergedChoice[m.pattern] ?? "import"}
									options={["import", "keep", "drop"]}
									onChange={(v) =>
										setMergedChoice((c) => ({
											...c,
											[m.pattern]: v as MergedChoice,
										}))
									}
								/>
							</div>
						))}
					</section>
				)}

				{data && data.conflicts.length > 0 && (
					<section style={{ marginBottom: 18 }}>
						<SectionLabel>Conflicts — harnesses disagree</SectionLabel>
						{data.conflicts.map((c) => (
							<div
								key={c.pattern}
								data-testid="import-conflict-row"
								style={{ ...rowStyle, flexWrap: "wrap" }}
							>
								<code style={{ flex: 1, color: "var(--fg-strong)" }}>
									{c.pattern}
								</code>
								<span
									style={{
										color: "var(--fg-mute)",
										fontSize: 11.5,
										fontFamily: "var(--font-mono)",
									}}
								>
									{Object.entries(c.options)
										.map(([k, h]) => `${k}: ${h.join(",")}`)
										.join("  ·  ")}
								</span>
								<ChoiceButtons
									value={conflictChoice[c.pattern] ?? "both"}
									options={[...Object.keys(c.options), "both", "keep", "drop"]}
									onChange={(v) =>
										setConflictChoice((cur) => ({
											...cur,
											[c.pattern]: v as ConflictChoice,
										}))
									}
								/>
							</div>
						))}
					</section>
				)}

				{data && data.un_importable.length > 0 && (
					<section style={{ marginBottom: 18 }}>
						<SectionLabel>Un-importable — left user-owned</SectionLabel>
						{data.un_importable.map((u, i) => (
							<div
								key={i}
								data-testid="import-unimportable-row"
								style={{ ...rowStyle, opacity: 0.7 }}
							>
								<Tag color="var(--fg-dim)">{u.harness ?? "?"}</Tag>
								<span style={{ flex: 1, color: "var(--fg-mute)", fontSize: 12 }}>
									{u.reason ?? "unsupported shape"}
								</span>
								<span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>
									read-only
								</span>
							</div>
						))}
					</section>
				)}

				{error && (
					<div
						role="alert"
						style={{
							padding: 10,
							borderRadius: "var(--radius)",
							border: "1px solid var(--red)",
							color: "var(--red)",
							marginBottom: 16,
							fontSize: 12,
						}}
					>
						{error}
					</div>
				)}

				<div
					style={{
						display: "flex",
						gap: 8,
						justifyContent: "flex-end",
						marginTop: 12,
					}}
				>
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant="primary"
						disabled={busy || loading || !!nothing}
						onClick={() => void apply()}
					>
						{busy ? "Applying…" : "Apply"}
					</Button>
				</div>
			</div>
		</div>
	);
}

const rowStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	padding: "6px 8px",
	borderTop: "1px solid var(--border)",
	fontFamily: "var(--font-mono)",
	fontSize: 12,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				fontSize: 11,
				textTransform: "uppercase",
				letterSpacing: "0.06em",
				color: "var(--fg-dim)",
				fontFamily: "var(--font-mono)",
				marginBottom: 4,
			}}
		>
			{children}
		</div>
	);
}

function ChoiceButtons({
	value,
	options,
	onChange,
}: {
	value: string;
	options: string[];
	onChange: (v: string) => void;
}) {
	return (
		<span style={{ display: "flex", gap: 3 }} role="group">
			{options.map((opt) => (
				<button
					key={opt}
					type="button"
					aria-pressed={value === opt}
					onClick={() => onChange(opt)}
					style={{
						padding: "2px 8px",
						borderRadius: 6,
						border: "1px solid var(--bg-3)",
						background:
							value === opt ? "var(--violet)" : "transparent",
						color: value === opt ? "white" : "var(--fg-mid)",
						fontFamily: "var(--font-mono)",
						fontSize: 10.5,
						cursor: "pointer",
					}}
				>
					{opt}
				</button>
			))}
		</span>
	);
}
