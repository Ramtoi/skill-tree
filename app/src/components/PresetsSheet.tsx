import {
	useEffect,
	useMemo,
	useState,
	type FormEvent,
} from "react";
import { invoke } from "@/lib/ipc";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconPicker, DEFAULT_ICON_CHOICES } from "./IconPicker";
import { useToast } from "./Toast";
import {
	BUILTIN_PRESET_IDS,
	type PermissionPreset,
	type PresetRule,
} from "@/lib/permissionPresets";
import { usePermissionPresets } from "@/hooks/usePermissionPresets";
import type { Rule, Scope } from "@/types/permissions";

export interface PresetsSheetProps {
	open: boolean;
	scope: Scope;
	/** Existing draft rules (used for already-added detection). */
	currentRules: Rule[];
	/** Called with the rules the user selected to apply. */
	onApplyRules: (rules: Rule[]) => void;
	onClose: () => void;
}

type RightPanelMode = "view" | "create" | "edit";

function ruleKey(pattern: string, kind: string): string {
	return `${kind}::${pattern}`;
}

/** Build the set of `(kind, pattern)` keys already present in the draft. */
function buildExistingKeySet(rules: Rule[]): Set<string> {
	const out = new Set<string>();
	for (const r of rules) {
		out.add(ruleKey(r.pattern, r.kind));
	}
	return out;
}

export function PresetsSheet({
	open,
	scope: _scope,
	currentRules,
	onApplyRules,
	onClose,
}: PresetsSheetProps) {
	const { presets } = usePermissionPresets();
	const queryClient = useQueryClient();
	const toast = useToast();

	const [activeId, setActiveId] = useState<string | null>(null);
	const [checked, setChecked] = useState<Record<string, boolean>>({});
	const [mode, setMode] = useState<RightPanelMode>("view");
	const [busy, setBusy] = useState(false);

	const activePreset = useMemo(
		() => presets.find((p) => p.id === activeId) ?? presets[0] ?? null,
		[presets, activeId],
	);

	// When the sheet opens, default to the first preset and seed checks.
	useEffect(() => {
		if (!open) return;
		const first = presets[0] ?? null;
		setActiveId((current) => current ?? first?.id ?? null);
		setMode("view");
	}, [open, presets]);

	// Whenever the active preset changes, reset per-rule checked state to defaults.
	useEffect(() => {
		if (!activePreset) {
			setChecked({});
			return;
		}
		const next: Record<string, boolean> = {};
		for (const r of activePreset.rules) {
			next[r.pattern] = r.enabledByDefault;
		}
		setChecked(next);
	}, [activePreset]);

	// Close on Escape.
	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	const existingKeys = buildExistingKeySet(currentRules);

	function isAlreadyAdded(rule: PresetRule): boolean {
		return existingKeys.has(ruleKey(rule.pattern, rule.kind));
	}

	function selectableRules(preset: PermissionPreset): PresetRule[] {
		return preset.rules.filter((r) => !isAlreadyAdded(r));
	}

	function selectedRules(preset: PermissionPreset): PresetRule[] {
		return selectableRules(preset).filter((r) => checked[r.pattern]);
	}

	function selectAll() {
		if (!activePreset) return;
		const next: Record<string, boolean> = { ...checked };
		for (const r of activePreset.rules) {
			if (isAlreadyAdded(r)) continue;
			next[r.pattern] = true;
		}
		setChecked(next);
	}

	function selectDefaults() {
		if (!activePreset) return;
		const next: Record<string, boolean> = {};
		for (const r of activePreset.rules) {
			next[r.pattern] = r.enabledByDefault && !isAlreadyAdded(r);
		}
		setChecked(next);
	}

	function toggle(pattern: string) {
		setChecked((c) => ({ ...c, [pattern]: !c[pattern] }));
	}

	function apply() {
		if (!activePreset) return;
		const chosen = selectedRules(activePreset);
		if (chosen.length === 0) return;
		const rules: Rule[] = chosen.map((r) => ({
			pattern: r.pattern,
			kind: r.kind,
		}));
		onApplyRules(rules);
		onClose();
	}

	async function refresh() {
		await queryClient.invalidateQueries({ queryKey: ["registry"] });
	}

	async function createUserPreset(input: {
		id: string;
		name: string;
		icon: string;
	}): Promise<boolean> {
		setBusy(true);
		try {
			const result = await invoke<{ success: boolean; output: string }>(
				"hub_cmd",
				{
					args: [
						"permissions",
						"presets",
						"new",
						input.id,
						"--name",
						input.name,
						"--icon",
						input.icon,
					],
				},
			);
			if (!result.success) throw new Error(result.output);
			await refresh();
			setActiveId(input.id);
			setMode("view");
			toast.success(`Created preset ${input.id}`);
			return true;
		} catch (err) {
			toast.error(`Create failed: ${String(err)}`);
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function deleteUserPreset(id: string) {
		setBusy(true);
		try {
			const result = await invoke<{ success: boolean; output: string }>(
				"hub_cmd",
				{ args: ["permissions", "presets", "delete", id] },
			);
			if (!result.success) throw new Error(result.output);
			await refresh();
			// Re-anchor selection to the first built-in.
			setActiveId(BUILTIN_PRESET_IDS.values().next().value ?? null);
			setMode("view");
			toast.success(`Deleted preset ${id}`);
		} catch (err) {
			toast.error(`Delete failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function updateUserPreset(input: {
		id: string;
		name?: string;
		description?: string;
		icon?: string;
		addRule?: string;
		removeRule?: string;
	}) {
		const args: string[] = ["permissions", "presets", "update", input.id];
		if (input.name !== undefined) args.push("--name", input.name);
		if (input.description !== undefined)
			args.push("--description", input.description);
		if (input.icon !== undefined) args.push("--icon", input.icon);
		if (input.addRule) args.push("--add-rule", input.addRule);
		if (input.removeRule) args.push("--remove-rule", input.removeRule);
		setBusy(true);
		try {
			const result = await invoke<{ success: boolean; output: string }>(
				"hub_cmd",
				{ args },
			);
			if (!result.success) throw new Error(result.output);
			await refresh();
		} catch (err) {
			toast.error(`Update failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	const builtins = presets.filter((p) => p.builtin);
	const userPresets = presets.filter((p) => !p.builtin);

	const selectedCount =
		activePreset && mode === "view" ? selectedRules(activePreset).length : 0;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="presets-sheet-title"
			className="presets-sheet-backdrop"
			onClick={onClose}
		>
			<div
				className="presets-sheet"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="presets-sheet-header">
					<h2 id="presets-sheet-title">Permission Presets</h2>
					<button
						type="button"
						className="presets-sheet-close"
						aria-label="Close presets"
						onClick={onClose}
					>
						<Icon name="x" size={12} />
					</button>
				</header>

				<div className="presets-sheet-body">
					{/* Left panel — preset list */}
					<aside className="presets-list">
						<div className="presets-list-section">
							<div className="presets-list-section-title">BUILT-IN</div>
							{builtins.map((p) => (
								<PresetListRow
									key={p.id}
									preset={p}
									active={p.id === activePreset?.id && mode === "view"}
									onSelect={() => {
										setActiveId(p.id);
										setMode("view");
									}}
								/>
							))}
						</div>
						<div className="presets-list-section">
							<div className="presets-list-section-title">YOUR PRESETS</div>
							{userPresets.length === 0 ? (
								<div className="presets-list-empty">No custom presets yet</div>
							) : (
								userPresets.map((p) => (
									<PresetListRow
										key={p.id}
										preset={p}
										active={p.id === activePreset?.id && mode === "view"}
										onSelect={() => {
											setActiveId(p.id);
											setMode("view");
										}}
									/>
								))
							)}
							<button
								type="button"
								className="presets-list-row presets-list-new"
								aria-pressed={mode === "create"}
								onClick={() => {
									setActiveId(null);
									setMode("create");
								}}
							>
								<span className="presets-list-icon">＋</span>
								<span className="presets-list-name">New preset</span>
							</button>
						</div>
					</aside>

					{/* Right panel — rule list or create/edit form */}
					<section className="presets-detail">
						{mode === "create" ? (
							<NewPresetForm
								busy={busy}
								onCancel={() => setMode("view")}
								onSubmit={createUserPreset}
							/>
						) : mode === "edit" && activePreset ? (
							<EditPresetForm
								preset={activePreset}
								busy={busy}
								onClose={() => setMode("view")}
								onUpdate={updateUserPreset}
								onDelete={async () => {
									await deleteUserPreset(activePreset.id);
								}}
							/>
						) : activePreset ? (
							<>
								<div className="presets-detail-header">
									<div className="presets-detail-title">
										<span className="presets-detail-icon">
											{activePreset.icon}
										</span>
										<div>
											<h3>{activePreset.name}</h3>
											<div className="presets-detail-meta">
												<span className="presets-category-chip">
													{activePreset.category}
												</span>
												{activePreset.description && (
													<span className="presets-detail-desc">
														{activePreset.description}
													</span>
												)}
											</div>
										</div>
									</div>
									{!activePreset.builtin && (
										<button
											type="button"
											className="presets-edit-btn"
											aria-label="Edit preset"
											onClick={() => setMode("edit")}
										>
											<Icon name="edit" size={12} />
										</button>
									)}
								</div>

								<div className="presets-rule-list" aria-label="Preset rules">
									{activePreset.rules.length === 0 ? (
										<div className="presets-empty">
											This preset has no rules yet.
										</div>
									) : (
										activePreset.rules.map((r) => {
											const added = isAlreadyAdded(r);
											return (
												<label
													key={r.pattern}
													className={`presets-rule-row${added ? " is-added" : ""}`}
												>
													<input
														type="checkbox"
														aria-label={`Toggle ${r.pattern}`}
														checked={!added && !!checked[r.pattern]}
														disabled={added}
														onChange={() => toggle(r.pattern)}
													/>
													<code className="presets-rule-pattern">
														{r.pattern}
													</code>
													<span className="presets-rule-desc">
														{r.description}
													</span>
													{added && (
														<span className="presets-rule-added">
															already added
														</span>
													)}
												</label>
											);
										})
									)}
								</div>

								<footer className="presets-detail-footer">
									<div className="presets-footer-actions">
										<Button variant="ghost" onClick={selectAll}>
											Select all
										</Button>
										<Button variant="ghost" onClick={selectDefaults}>
											Select defaults
										</Button>
									</div>
									<Button
										variant="primary"
										onClick={apply}
										disabled={selectedCount === 0}
									>
										{selectedCount === 0
											? "Apply rules"
											: `Apply ${selectedCount} rule${selectedCount === 1 ? "" : "s"} →`}
									</Button>
								</footer>
							</>
						) : (
							<div className="presets-empty">No preset selected.</div>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}

function PresetListRow({
	preset,
	active,
	onSelect,
}: {
	preset: PermissionPreset;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className="presets-list-row"
			aria-pressed={active}
			onClick={onSelect}
		>
			<span className="presets-list-icon" aria-hidden="true">
				{preset.icon}
			</span>
			<span className="presets-list-name">{preset.name}</span>
			<span className="presets-list-count">{preset.rules.length}</span>
		</button>
	);
}


function NewPresetForm({
	busy,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	onCancel: () => void;
	onSubmit: (input: {
		id: string;
		name: string;
		icon: string;
	}) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [icon, setIcon] = useState(DEFAULT_ICON_CHOICES[0]);

	function slugify(value: string): string {
		return value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	async function handle(e: FormEvent) {
		e.preventDefault();
		const slug = slugify(name);
		if (!slug) return;
		await onSubmit({ id: slug, name: name.trim(), icon });
	}

	const slug = slugify(name);

	return (
		<form className="presets-create-form" onSubmit={handle}>
			<h3>Create preset</h3>
			<label className="presets-field">
				<span>Name</span>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="My custom preset"
					autoFocus
				/>
				{slug && (
					<span className="presets-field-hint">
						id: <code>{slug}</code>
					</span>
				)}
			</label>
			<div className="presets-field">
				<span>Icon</span>
				<IconPicker value={icon} onChange={setIcon} />
			</div>
			<div className="presets-form-actions">
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={busy || !slug}
				>
					{busy ? "Saving…" : "Save"}
				</Button>
			</div>
		</form>
	);
}

function EditPresetForm({
	preset,
	busy,
	onClose,
	onUpdate,
	onDelete,
}: {
	preset: PermissionPreset;
	busy: boolean;
	onClose: () => void;
	onUpdate: (input: {
		id: string;
		name?: string;
		description?: string;
		icon?: string;
		addRule?: string;
		removeRule?: string;
	}) => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [name, setName] = useState(preset.name);
	const [description, setDescription] = useState(preset.description);
	const [icon, setIcon] = useState(preset.icon);
	const [newRule, setNewRule] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		setName(preset.name);
		setDescription(preset.description);
		setIcon(preset.icon);
		setConfirmDelete(false);
	}, [preset.id, preset.name, preset.description, preset.icon]);

	const dirty =
		name !== preset.name ||
		description !== preset.description ||
		icon !== preset.icon;

	async function saveMeta(e: FormEvent) {
		e.preventDefault();
		if (!dirty) return;
		await onUpdate({ id: preset.id, name, description, icon });
	}

	async function addRule() {
		const pat = newRule.trim();
		if (!pat) return;
		await onUpdate({ id: preset.id, addRule: pat });
		setNewRule("");
	}

	async function removeRule(pattern: string) {
		await onUpdate({ id: preset.id, removeRule: pattern });
	}

	return (
		<form className="presets-edit-form" onSubmit={saveMeta}>
			<div className="presets-detail-header">
				<h3>Edit preset</h3>
				<button
					type="button"
					className="presets-close-edit"
					onClick={onClose}
					aria-label="Done editing"
				>
					<Icon name="x" size={12} />
				</button>
			</div>
			<label className="presets-field">
				<span>Name</span>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			<label className="presets-field">
				<span>Description</span>
				<input
					type="text"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			<div className="presets-field">
				<span>Icon</span>
				<IconPicker value={icon} onChange={setIcon} />
			</div>
			<div className="presets-form-actions">
				<Button variant="ghost" onClick={onClose}>
					Close
				</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={busy || !dirty}
				>
					Save changes
				</Button>
			</div>

			<div className="presets-edit-rules">
				<h4>Rules</h4>
				<div className="presets-rule-list">
					{preset.rules.length === 0 ? (
						<div className="presets-empty">No rules yet.</div>
					) : (
						preset.rules.map((r) => (
							<div key={r.pattern} className="presets-edit-rule-row">
								<code className="presets-rule-pattern">{r.pattern}</code>
								<span className="presets-rule-desc">{r.description}</span>
								<button
									type="button"
									className="presets-rule-remove"
									aria-label={`Remove ${r.pattern}`}
									onClick={() => removeRule(r.pattern)}
								>
									<Icon name="x" size={11} />
								</button>
							</div>
						))
					)}
				</div>
				<div className="presets-edit-add">
					<input
						type="text"
						value={newRule}
						onChange={(e) => setNewRule(e.target.value)}
						placeholder="Bash(npm run *)"
						aria-label="New rule pattern"
					/>
					<Button
						variant="ghost"
						onClick={addRule}
						disabled={busy || !newRule.trim()}
					>
						Add rule
					</Button>
				</div>
			</div>

			<div className="presets-danger">
				{confirmDelete ? (
					<>
						<span>Delete preset {preset.id}?</span>
						<Button variant="ghost" onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
						<button
							type="button"
							className="presets-danger-confirm"
							onClick={onDelete}
							disabled={busy}
						>
							Delete preset
						</button>
					</>
				) : (
					<button
						type="button"
						className="presets-danger-trigger"
						onClick={() => setConfirmDelete(true)}
					>
						Delete preset
					</button>
				)}
			</div>
		</form>
	);
}
