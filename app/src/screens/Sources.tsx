import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { Button } from "@/components/Button";
import { LoadingButton, RowProgress } from "@/components/loading";
import { useProcessFor } from "@/store/processes";
import { trackProcess } from "@/lib/trackProcess";
import { Chip, Chips } from "@/components/Chips";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "@/components/SectionHeader";
import { KindTag, ScopeBadge, Tag } from "@/components/Tag";
import { useRegistry } from "@/hooks/useRegistry";
import {
	applySourceWithDecisions,
	type ConflictDecision,
} from "@/hooks/useSources";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { deriveSources, inferSkillSourceId, sourceAccent } from "@/lib/skillSource";
import type { SkillScope, SkillType, SourceStatus, SourceType, SourceView } from "@/types";

type FilterKind = "all" | "builtin" | "git" | "coming-soon";

/** Max skill chips shown before a card collapses behind a "+N more" toggle. */
const COLLAPSE_LIMIT = 8;

function fmtTimestamp(s: string | null | undefined): string {
	if (!s) return "—";
	try {
		const d = new Date(s);
		return d.toLocaleString();
	} catch {
		return s;
	}
}

const SOURCE_TYPE_ICON: Record<SourceType, string> = {
	git: "source.git",
	starter: "source.starter",
	local: "source.local",
	litellm: "source.litellm",
};

const SOURCE_DESC: Record<string, string> = {
	local: "Skills you authored or imported as local copies.",
	starter: "Bundled starter pack shipped with Skill Hub.",
};

const STATUS_META: Record<string, { color: string; label: string }> = {
	"up-to-date": { color: "var(--green)", label: "up to date" },
	"update-available": { color: "var(--blue)", label: "update available" },
	syncing: { color: "var(--violet-2)", label: "syncing…" },
	error: { color: "var(--red)", label: "auth error" },
	unknown: { color: "var(--fg-dim)", label: "unknown" },
	local: { color: "var(--fg-mute)", label: "local" },
	bundled: { color: "var(--cyan)", label: "bundled" },
};

function SourceStatusLabel({ status }: { status: SourceStatus | undefined }) {
	const meta = STATUS_META[status ?? "unknown"] ?? {
		color: "var(--fg-dim)",
		label: status ?? "unknown",
	};
	return (
		<span className="source-status">
			<span className="status-dot" style={{ background: meta.color }} />
			<span className="status-label">{meta.label}</span>
		</span>
	);
}

async function hubCmd(args: string[]): Promise<{ success: boolean; output: string }> {
	return invoke<{ success: boolean; output: string }>("hub_cmd", { args });
}

export function Sources() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const toast = useToast();
	const { data: registry } = useRegistry();
	const [filter, setFilter] = useState<FilterKind>("all");
	const [showAdd, setShowAdd] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (searchParams.get("add") === "1") {
			setShowAdd(true);
		}
	}, [searchParams]);

	function closeAdd() {
		setShowAdd(false);
		if (searchParams.get("add") === "1") {
			const next = new URLSearchParams(searchParams);
			next.delete("add");
			setSearchParams(next, { replace: true });
		}
	}

	const sources = useMemo<SourceView[]>(() => deriveSources(registry), [registry]);
	const externalCount = sources.filter((s) => !s.builtin).length;
	const managedCount = sources.reduce(
		(acc, s) => acc + (s.builtin ? 0 : s.skill_count ?? 0),
		0,
	);

	const visible = useMemo(
		() =>
			sources.filter((s) => {
				if (filter === "all") return true;
				if (filter === "builtin") return s.builtin;
				if (filter === "git") return s.type === "git";
				if (filter === "coming-soon") return s.type === "litellm";
				return true;
			}),
		[sources, filter],
	);

	const configured = useMemo(
		() => visible.filter((s) => s.type !== "litellm"),
		[visible],
	);
	const comingSoon = useMemo(
		() => visible.filter((s) => s.type === "litellm"),
		[visible],
	);

	async function onCheckAll() {
		setBusy(true);
		try {
			let checked = 0;
			for (const s of sources.filter((x) => x.type === "git")) {
				try {
					await hubCmd(["source", "check", s.id, "--json"]);
					checked++;
				} catch {
					/* per-source errors land in the source entry's `error` field */
				}
			}
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Checked ${checked} source${checked === 1 ? "" : "s"}`);
		} finally {
			setBusy(false);
		}
	}

	async function onSyncAll() {
		setBusy(true);
		try {
			let synced = 0;
			for (const s of sources.filter(
				(x) => x.type === "git" && x.status === "update-available",
			)) {
				try {
					await hubCmd(["source", "sync", s.id, "--json"]);
					synced++;
				} catch {
					/* per-source errors land in the source entry's `error` field */
				}
			}
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Synced ${synced} source${synced === 1 ? "" : "s"}`);
		} finally {
			setBusy(false);
		}
	}

	async function onSyncSource(source: SourceView) {
		if (source.type !== "git") return;
		setBusy(true);
		try {
			await trackProcess(
				{
					title: `Syncing ${source.name}`,
					body: "git fetch origin",
					kind: "remote",
					target: source.id,
				},
				async () => {
					const res = await hubCmd(["source", "sync", source.id, "--json"]);
					if (!res.success) throw new Error(res.output);
					await queryClient.invalidateQueries({ queryKey: ["registry"] });
				},
				{
					successBody: `${source.name} · registry updated`,
					retry: () => void onSyncSource(source),
				},
			);
		} catch {
			/* error surfaced on the process card */
		} finally {
			setBusy(false);
		}
	}

	async function onCheckSource(source: SourceView) {
		if (source.type !== "git") return;
		setBusy(true);
		try {
			const res = await hubCmd(["source", "check", source.id, "--json"]);
			if (!res.success) throw new Error(res.output);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Checked ${source.name}`);
		} catch (err) {
			toast.error(`Check failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function onRemoveSource(source: SourceView) {
		if (source.type !== "git") return;
		const confirmed = window.confirm(
			`Remove source "${source.name}"?\n\nThis will unequip its ${source.skill_count ?? 0} skill(s) from all bundles and projects. Use the CLI for keep-local mode.`,
		);
		if (!confirmed) return;
		setBusy(true);
		try {
			const res = await hubCmd([
				"source",
				"remove",
				source.id,
				"--mode",
				"unequip",
				"--json",
			]);
			if (!res.success) throw new Error(res.output);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Removed ${source.name}`);
		} catch (err) {
			toast.error(`Remove failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<ScreenHeader
				title="External Sources"
				meta={
					<Tag size="md" color="var(--fg-mute)" style={{ textTransform: "none" }}>
						{externalCount} external · {managedCount} managed skills
					</Tag>
				}
				crumbs={["skill-tree", "sources"]}
				primary={
					<Button variant="primary" icon="plus" onClick={() => setShowAdd(true)}>
						Add source
					</Button>
				}
				overflow={[
					{
						icon: "refresh",
						label: "Check all sources",
						disabled: busy,
						onClick: () => void onCheckAll(),
					},
					{
						icon: "bolt",
						label: "Sync all updates",
						disabled: busy,
						onClick: () => void onSyncAll(),
					},
				]}
				subheader={{
					left: (
						<Chips role="tablist">
							<Chip pressed={filter === "all"} onClick={() => setFilter("all")}>
								All
							</Chip>
							<Chip
								pressed={filter === "builtin"}
								onClick={() => setFilter("builtin")}
							>
								Built-in
							</Chip>
							<Chip pressed={filter === "git"} onClick={() => setFilter("git")}>
								Git
							</Chip>
							<Chip
								pressed={filter === "coming-soon"}
								onClick={() => setFilter("coming-soon")}
							>
								Coming soon
							</Chip>
						</Chips>
					),
				}}
			/>

			<div className="main-body sources-body">
				{visible.length === 0 ? (
					<EmptyState
						icon="link"
						title="No sources in this view"
						description="Try clearing the filter or add a Git source."
					/>
				) : (
					<>
						<SectionHeader label="Configured sources" count={configured.length} />
						<div className="source-list">
							{configured.map((source) => (
								<SourceCard
									key={source.id}
									source={source}
									registry={registry}
									onCheck={() => void onCheckSource(source)}
									onSync={() => void onSyncSource(source)}
									onRemove={() => void onRemoveSource(source)}
									onSkillClick={(name) =>
										navigate(`/skill/${encodeURIComponent(name)}`)
									}
									busy={busy}
								/>
							))}
						</div>

						{comingSoon.length > 0 && (
							<>
								<SectionHeader label="Coming soon" count={comingSoon.length} />
								<div className="source-list">
									{comingSoon.map((source) => (
										<SourceCard
											key={source.id}
											source={source}
											registry={registry}
											disabled
										/>
									))}
								</div>
							</>
						)}
						<div style={{ height: 80 }} />
					</>
				)}
			</div>

			{showAdd && <AddSourceModal onClose={closeAdd} />}
		</>
	);
}

interface OwnedSkill {
	name: string;
	scope: SkillScope;
	type: SkillType;
}

interface SourceCardProps {
	source: SourceView;
	registry: ReturnType<typeof useRegistry>["data"];
	onCheck?: () => void;
	onSync?: () => void;
	onRemove?: () => void;
	onSkillClick?: (name: string) => void;
	busy?: boolean;
	disabled?: boolean;
}

function SourceCard({
	source,
	registry,
	onCheck,
	onSync,
	onRemove,
	onSkillClick,
	busy,
	disabled,
}: SourceCardProps) {
	const accent = sourceAccent(source.id);
	const isExternal = source.type === "git";
	const updateAvail = source.status === "update-available";
	const isError = source.status === "error";

	const [expanded, setExpanded] = useState(false);

	const proc = useProcessFor(source.id);
	const isRunning = proc?.status === "running";

	const ownedSkills = useMemo<OwnedSkill[]>(() => {
		if (!registry) return [];
		const out: OwnedSkill[] = [];
		for (const [name, skill] of Object.entries(registry.skills ?? {})) {
			if (inferSkillSourceId(skill) === source.id) {
				out.push({ name, scope: skill.scope, type: skill.type });
			}
		}
		return out;
	}, [registry, source.id]);

	const overflow = ownedSkills.length - COLLAPSE_LIMIT;
	const shownSkills = expanded ? ownedSkills : ownedSkills.slice(0, COLLAPSE_LIMIT);

	const skillsBlock = (isExternal || ownedSkills.length > 0) && (
		<div className="source-imported">
			<div className="source-imported-label">
				{isExternal ? "Imported skills" : "Skills"}
			</div>
			<div className="source-imported-list">
				{ownedSkills.length === 0 && (
					<span className="text-dim text-mono">No skills imported yet.</span>
				)}
				{shownSkills.map((sk) => (
					<span
						key={sk.name}
						className="source-imported-chip"
						onClick={(e) => {
							e.stopPropagation();
							onSkillClick?.(sk.name);
						}}
					>
						<ScopeBadge scope={sk.scope} />
						<span className="name">{sk.name}</span>
						<KindTag kind={sk.type} />
					</span>
				))}
				{overflow > 0 && (
					<button
						type="button"
						className="source-imported-toggle"
						aria-expanded={expanded}
						onClick={(e) => {
							e.stopPropagation();
							setExpanded((v) => !v);
						}}
					>
						{expanded ? "Show less" : `+${overflow} more`}
						<Icon name={expanded ? "chevronUp" : "chevronDown"} size={11} />
					</button>
				)}
			</div>
		</div>
	);

	return (
		<div
			className="source-card"
			data-source={source.id}
			data-status={source.status}
			data-disabled={disabled || undefined}
			data-running={isRunning ? "true" : undefined}
			style={{ "--src-accent": accent, "--lds-accent": accent } as CSSProperties}
		>
			<div className="source-card-head">
				<div className="source-glyph">
					<Icon name={SOURCE_TYPE_ICON[source.type]} size={18} />
				</div>

				<div className="source-card-id">
					<div className="source-card-name">
						{source.name}
						{source.builtin && <Tag color="var(--fg-mute)">BUILT-IN</Tag>}
						{source.type === "litellm" && <Tag color="var(--violet)">COMING SOON</Tag>}
						{updateAvail && <Tag color="var(--blue)">UPDATE AVAILABLE</Tag>}
						{isError && <Tag color="var(--red)">ERROR</Tag>}
					</div>
					{isExternal ? (
						<div className="source-card-meta">
							<span className="text-mono text-dim">{source.url ?? "—"}</span>
							{source.branch && (
								<>
									<span className="sep">·</span>
									<span className="text-mono">{source.branch}</span>
								</>
							)}
							{source.path && (
								<>
									<span className="sep">·</span>
									<span className="text-mono text-dim">/{source.path}</span>
								</>
							)}
						</div>
					) : (
						<div className="source-card-meta">
							<span className="text-mute">{SOURCE_DESC[source.id] ?? ""}</span>
						</div>
					)}
				</div>

				<div className="source-card-stat">
					<div className="value">{source.skill_count ?? ownedSkills.length}</div>
					<div className="label">skills</div>
				</div>

				{!disabled && isExternal && (
					<div className="source-card-actions" onClick={(e) => e.stopPropagation()}>
						<Button
							variant="ghost"
							size="sm"
							icon="refresh"
							onClick={onCheck}
							disabled={busy || isRunning}
						>
							Check
						</Button>
						<LoadingButton
							variant={updateAvail ? "primary" : "ghost"}
							size="sm"
							icon={updateAvail ? "bolt" : "refresh"}
							onClick={onSync}
							disabled={busy}
							loading={isRunning}
							loadingLabel={
								proc && !proc.indeterminate
									? `Syncing… ${Math.round((proc.progress ?? 0) * 100)}%`
									: "Syncing…"
							}
						>
							{updateAvail ? "Sync update" : "Sync"}
						</LoadingButton>
						<Button
							variant="ghost"
							size="sm"
							icon="trash"
							onClick={onRemove}
							disabled={busy}
							title="Remove source…"
						/>
					</div>
				)}
			</div>

			{isRunning && (
				<RowProgress
					value={proc.indeterminate ? null : proc.progress}
					accent={accent}
				/>
			)}

			{isExternal && !disabled && (
				<div className="source-card-detail">
					<div className="source-detail-row">
						<span className="k">current</span>
						<span className="v text-mono">
							{source.current_ref ? source.current_ref.slice(0, 7) : "—"}
						</span>
						{updateAvail && (
							<>
								<Icon name="arrowRight" size={11} style={{ color: "var(--blue)" }} />
								<span className="v text-mono" style={{ color: "var(--blue)" }}>
									{source.remote_ref ? source.remote_ref.slice(0, 7) : "—"}
								</span>
							</>
						)}
						<span className="dot-sep" />
						<SourceStatusLabel status={source.status} />
						{source.last_checked_at && (
							<>
								<span className="dot-sep" />
								<span className="k">checked {fmtTimestamp(source.last_checked_at)}</span>
							</>
						)}
						{source.last_synced_at && (
							<>
								<span className="dot-sep" />
								<span className="k">synced {fmtTimestamp(source.last_synced_at)}</span>
							</>
						)}
					</div>

					{isError && source.error && (
						<div className="source-error">
							<Icon name="warning" size={12} />
							<span>{source.error}</span>
							<Button variant="ghost" size="sm">
								Configure auth
							</Button>
						</div>
					)}

					{skillsBlock}
				</div>
			)}

			{!isExternal && !disabled && (
				<div className="source-card-detail">
					<div className="source-detail-row">
						<SourceStatusLabel status={source.status} />
						<span className="dot-sep" />
						<span className="k">{ownedSkills.length} skills owned</span>
						<span className="dot-sep" />
						<span className="k text-mono">~/.skill-hub/skills</span>
					</div>
					{skillsBlock}
				</div>
			)}
		</div>
	);
}

interface AddSourceModalProps {
	onClose: () => void;
}

function AddSourceModal({ onClose }: AddSourceModalProps) {
	const toast = useToast();
	const [url, setUrl] = useState("");
	const [id, setId] = useState("");
	const [branch, setBranch] = useState("");
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
	const [resolved, setResolved] = useState<
		Array<{ name: string; action: string; final_name: string }> | null
	>(null);
	const [preview, setPreview] = useState<{
		counts: { new: number; conflicts: number; imported: number; invalid: number };
		candidates: Array<{ name: string; category: string; origin_path: string }>;
	} | null>(null);

	const conflicts = useMemo(
		() =>
			(preview?.candidates ?? []).filter(
				(c) => c.category.toUpperCase() === "CONFLICT",
			),
		[preview],
	);
	function decisionFor(name: string): ConflictDecision {
		return decisions[name] ?? "skip";
	}

	async function onPreview(e: FormEvent) {
		e.preventDefault();
		if (!url.trim()) {
			toast.error("Repository URL is required");
			return;
		}
		setBusy(true);
		try {
			const args = ["source", "add", "git", url, "--dry-run", "--json"];
			if (id) args.push("--id", id);
			if (branch) args.push("--branch", branch);
			if (path) args.push("--path", path);
			const res = await hubCmd(args);
			const payload = JSON.parse(res.output);
			if (!payload.ok) throw new Error(payload.error || "preview failed");
			setPreview({ counts: payload.counts, candidates: payload.candidates });
		} catch (err) {
			toast.error(`Preview failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function onApply() {
		setBusy(true);
		try {
			const args = ["source", "add", "git", url];
			if (id) args.push("--id", id);
			if (branch) args.push("--branch", branch);
			if (path) args.push("--path", path);
			const payload = await applySourceWithDecisions(args, decisions);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			await queryClient.invalidateQueries({ queryKey: ["sources"] });
			await queryClient.invalidateQueries({ queryKey: ["localCandidates"] });
			const resolvedRows = payload.resolved ?? [];
			setResolved(resolvedRows);
			const replaced = resolvedRows.filter((r) => r.action === "replace").length;
			const suffixed = resolvedRows.filter((r) => r.action === "suffix").length;
			const extra =
				replaced || suffixed
					? ` · ${replaced} replaced, ${suffixed} renamed`
					: "";
			toast.success(
				`Added source with ${payload.registered.length} skill(s)${extra}`,
			);
		} catch (err) {
			toast.error(`Add failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.5)",
				display: "grid",
				placeItems: "center",
				zIndex: 50,
			}}
			onClick={onClose}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					background: "var(--bg-1)",
					border: "1px solid var(--border)",
					borderRadius: 8,
					width: 560,
					maxWidth: "90vw",
					padding: 20,
					display: "flex",
					flexDirection: "column",
					gap: 12,
				}}
			>
				<h3 style={{ margin: 0 }}>Add Git source</h3>
				<p style={{ margin: 0, color: "var(--fg-mute)", fontSize: 12 }}>
					Discovery scans the configured subdirectory, its immediate children, and conventional{" "}
					<code>skills/</code> / <code>mcp-servers/</code> folders. SSH or HTTPS uses your system Git
					auth — credentials are never stored in <code>registry.yaml</code>.
				</p>
				<p
					style={{
						margin: 0,
						color: "var(--fg-mute)",
						fontSize: 11,
						borderLeft: "3px solid var(--fg-mute)",
						paddingLeft: 8,
					}}
				>
					LiteLLM Skills Gateway — coming soon. Will let you connect an organizational Skill
					Hub from a LiteLLM proxy.
				</p>
				<form onSubmit={onPreview} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
					<label style={{ gridColumn: "1 / 3", display: "flex", flexDirection: "column", gap: 4 }}>
						<span style={{ fontSize: 11, color: "var(--fg-mute)" }}>Repository URL</span>
						<input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="git@github.com:org/skills.git"
							autoFocus
							style={{ padding: "6px 8px" }}
						/>
					</label>
					<label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<span style={{ fontSize: 11, color: "var(--fg-mute)" }}>Source id (optional)</span>
						<input
							value={id}
							onChange={(e) => setId(e.target.value)}
							placeholder="derived from URL"
							style={{ padding: "6px 8px" }}
						/>
					</label>
					<label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<span style={{ fontSize: 11, color: "var(--fg-mute)" }}>Branch (optional)</span>
						<input
							value={branch}
							onChange={(e) => setBranch(e.target.value)}
							placeholder="auto-detect"
							style={{ padding: "6px 8px" }}
						/>
					</label>
					<label style={{ gridColumn: "1 / 3", display: "flex", flexDirection: "column", gap: 4 }}>
						<span style={{ fontSize: 11, color: "var(--fg-mute)" }}>
							Subdirectory (optional, repo-relative)
						</span>
						<input
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder="skills"
							style={{ padding: "6px 8px" }}
						/>
					</label>
					<div style={{ gridColumn: "1 / 3", display: "flex", gap: 8, justifyContent: "flex-end" }}>
						<Button variant="ghost" onClick={onClose} type="button">
							Cancel
						</Button>
						<Button variant="primary" type="submit" disabled={busy}>
							{busy ? "Previewing…" : "Preview"}
						</Button>
					</div>
				</form>

				{preview && !resolved && (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<SectionHeader label="Preview" />
						<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
							<Tag color="var(--green)">{preview.counts.new} new</Tag>
							<Tag color="var(--amber)">{preview.counts.conflicts} conflicts</Tag>
							<Tag color="var(--fg-mute)">{preview.counts.imported} already imported</Tag>
							<Tag color="var(--red)">{preview.counts.invalid} invalid</Tag>
						</div>
						<div style={{ maxHeight: 200, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
							{preview.candidates.map((c) => (
								<div
									key={c.name}
									style={{
										display: "flex",
										gap: 8,
										padding: "4px 6px",
										fontFamily: "var(--font-mono)",
										fontSize: 11,
									}}
								>
									<span style={{ minWidth: 70, color: "var(--fg-mute)" }}>{c.category}</span>
									<span>{c.name}</span>
									<span style={{ color: "var(--fg-mute)" }}>{c.origin_path}</span>
								</div>
							))}
						</div>

						{conflicts.length > 0 && (
							<div className="source-conflict-resolver">
								<SectionHeader
									label="Resolve conflicts"
									count={conflicts.length}
								/>
								<p style={{ margin: 0, fontSize: 11, color: "var(--fg-mute)" }}>
									These names already exist. Choose per skill — default keeps
									yours.
								</p>
								{conflicts.map((c) => (
									<div
										key={c.name}
										className="conflict-row"
										data-testid={`conflict-${c.name}`}
									>
										<span className="conflict-name text-mono">{c.name}</span>
										<Chips role="tablist">
											<Chip
												pressed={decisionFor(c.name) === "skip"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "skip" }))
												}
												title="Keep the existing skill; do not import"
											>
												Keep mine
											</Chip>
											<Chip
												pressed={decisionFor(c.name) === "replace"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "replace" }))
												}
												title="Overwrite the existing skill from this source"
											>
												Take theirs
											</Chip>
											<Chip
												pressed={decisionFor(c.name) === "suffix"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "suffix" }))
												}
												title="Import under a renamed skill (name-2)"
											>
												Import renamed
											</Chip>
										</Chips>
									</div>
								))}
							</div>
						)}

						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<Button variant="ghost" onClick={() => setPreview(null)}>
								Re-preview
							</Button>
							<Button
								variant="primary"
								onClick={() => void onApply()}
								disabled={
									busy ||
									(preview.counts.new === 0 &&
										!conflicts.some(
											(c) => decisionFor(c.name) !== "skip",
										))
								}
							>
								Apply
							</Button>
						</div>
					</div>
				)}

				{resolved && (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<SectionHeader label="Applied" count={resolved.length} />
						{resolved.length === 0 ? (
							<span className="text-dim text-mono" style={{ fontSize: 11 }}>
								No conflicts required resolution.
							</span>
						) : (
							<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
								{resolved.map((r) => (
									<div
										key={r.name}
										className="resolved-row text-mono"
										data-testid={`resolved-${r.name}`}
										style={{ display: "flex", gap: 8, fontSize: 11 }}
									>
										<span style={{ minWidth: 60, color: "var(--fg-mute)" }}>
											{r.action}
										</span>
										<span>{r.name}</span>
										<Icon name="arrowRight" size={10} />
										<span style={{ color: "var(--green)" }}>{r.final_name}</span>
									</div>
								))}
							</div>
						)}
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<Button variant="primary" onClick={onClose}>
								Done
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
