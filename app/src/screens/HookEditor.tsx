import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Field, MetaGrid } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { ConfirmDialog } from "@/components/Modal";
import { HookReachBadges } from "@/components/HookReachBadges";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	useHook,
	useHookCapabilities,
	useHookNew,
	useHookEdit,
	useHookDelete,
	useHookSetSettings,
	type HookShow,
} from "@/hooks/useHooks";
import { CANONICAL_EVENTS, hookToolVocabulary } from "@/lib/hookCatalog";

const SLUG_RE = /^[a-z0-9-]+$/;

/** LSP mode labels — honesty (D5): NEVER claim blocking prevents the edit (the
 *  edit already happened; this is a PostToolUse report). */
const LSP_MODE_OPTIONS: { value: string; label: string }[] = [
	{ value: "advisory", label: "report" },
	{ value: "blocking", label: "interrupt (agent must address)" },
];

interface LspLangSettings {
	enabled?: boolean;
	mode?: string;
	timeout?: number;
}

/**
 * Hook editor (`/hook/:name`, hooks-surface D7). A FORM composed from primitives
 * (not DocumentEditorShell): event picker, tools picker, command field, harness
 * affinity chips, a settings section (lsp-report gets a per-language table), and a
 * Danger zone. `name === "new"` is create mode. Built-ins render command/event/
 * matcher read-only; only their settings (per project) are editable. `⌘S` saves
 * core-field edits when dirty. All IPC goes through the useHooks hooks (→ lib/ipc).
 */
export function HookEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const isNew = routeName === "new";
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry } = useRegistry();
	const { data: capabilities } = useHookCapabilities();
	const harnesses = useHarnesses();
	const installedHarnesses = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);

	const { data: hook, isLoading, error } = useHook(isNew ? undefined : routeName);
	const newMut = useHookNew();
	const editMut = useHookEdit();
	const deleteMut = useHookDelete();
	const settingsMut = useHookSetSettings();

	const isBuiltin = hook?.provenance === "builtin";
	const coreReadOnly = isBuiltin; // built-in command/event/tools/matcher/etc.

	// ─── Core-field form state ────────────────────────────────────────────────
	const [name, setName] = useState("");
	const [event, setEvent] = useState<string>(CANONICAL_EVENTS[1]); // PostToolUse
	const [command, setCommand] = useState("");
	const [tools, setTools] = useState<string[]>([]);
	const [matcher, setMatcher] = useState("");
	const [timeout, setTimeoutVal] = useState<string>("");
	const [affinity, setAffinity] = useState<string[]>([]);
	const [dirty, setDirty] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	// Which hook the form is currently hydrated from. Hydration is keyed on this
	// IDENTITY — not on the react-query object — because every hook mutation
	// invalidates the whole ["hooks"] key (useHooks.invalidateHooks). A sibling
	// mutation on the SAME hook (notably "Save settings" in the side panel)
	// therefore refetches `hook_show` and hands us a NEW object whose contents
	// changed, which unconditional hydration would use to silently overwrite the
	// user's in-progress core-field edits and clear the UNSAVED pill. Mirrors the
	// identity-stamp guard in the Snippets editor (`loadedFor`) and SkillEditor's
	// route-keyed body load.
	const hydratedFor = useRef<string | null>(null);
	// The live dirty flag, readable inside the hydration effect WITHOUT being a
	// dependency: a dirty→false flip (e.g. right after a save) must not re-run
	// hydration against a not-yet-refetched definition.
	const dirtyRef = useRef(false);
	dirtyRef.current = dirty;

	// Hydrate from the loaded definition (edit mode).
	useEffect(() => {
		if (isNew || !hook) return;
		const identity = routeName ?? hook.name;
		// Same hook + unsaved edits ⇒ the user's buffer wins, WHOLESALE. We keep
		// every core field, not just the touched ones: a per-field merge would
		// mix server and local values into one save payload, so what the user
		// reviewed on screen is not what gets written. The refetched definition
		// is picked up by the next hydration (after a save clears `dirty`, or on
		// navigating to another hook).
		if (hydratedFor.current === identity && dirtyRef.current) return;
		// Clean form (or a different hook): adopt the server definition, so an
		// external `hub hook edit` / a just-saved value still shows up live.
		hydratedFor.current = identity;
		setName(hook.name);
		setEvent(hook.event || CANONICAL_EVENTS[1]);
		setCommand(hook.command || "");
		setTools(hook.tools ?? []);
		setMatcher(hook.matcher || "");
		setTimeoutVal(hook.timeout != null ? String(hook.timeout) : "");
		setAffinity(hook.harnesses ?? []);
		setDirty(false);
	}, [hook, isNew, routeName]);

	const mark = useCallback(<T,>(setter: (v: T) => void) => {
		return (v: T) => {
			setter(v);
			setDirty(true);
		};
	}, []);

	const toolVocab = useMemo(() => hookToolVocabulary(registry), [registry]);

	const save = useCallback(async () => {
		if (coreReadOnly) return;
		const canonical = name.trim();
		if (isNew && !SLUG_RE.test(canonical)) {
			toast.error("Hook name must use lowercase letters, numbers, and hyphens");
			return;
		}
		if (!command.trim()) {
			toast.error("Command is required");
			return;
		}
		const timeoutNum =
			timeout.trim() === "" ? null : Number.parseInt(timeout, 10);
		if (timeoutNum != null && Number.isNaN(timeoutNum)) {
			toast.error("Timeout must be a number of seconds");
			return;
		}
		try {
			if (isNew) {
				const res = await newMut.mutateAsync({
					name: canonical,
					event,
					command,
					tools,
					matcher: matcher || undefined,
					timeout: timeoutNum,
					harnesses: affinity.length ? affinity : undefined,
				});
				if (!res.success) throw new Error(res.output);
				setDirty(false);
				toast.success(`Created hook "${canonical}"`);
				navigate(`/hook/${encodeURIComponent(canonical)}`, { replace: true });
			} else {
				const res = await editMut.mutateAsync({
					name: canonical,
					event,
					command,
					tools,
					matcher,
					timeout: timeoutNum,
					harnesses: affinity,
				});
				if (!res.success) throw new Error(res.output);
				setDirty(false);
				toast.success(`Saved hook "${canonical}"`);
			}
		} catch (e) {
			toast.error("Couldn't save hook", String(e));
		}
	}, [
		coreReadOnly,
		isNew,
		name,
		event,
		command,
		tools,
		matcher,
		timeout,
		affinity,
		newMut,
		editMut,
		toast,
		navigate,
	]);

	// ⌘S / Ctrl+S saves when dirty (mirrors the editor keyboard contract).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				if (dirty && !coreReadOnly) void save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, coreReadOnly, save]);

	const doDelete = useCallback(async () => {
		if (!hook) return;
		try {
			const res = await deleteMut.mutateAsync({ name: hook.name, confirm: true });
			if (!res.success) throw new Error(res.output);
			toast.success(`Deleted hook "${hook.name}"`);
			navigate("/hooks");
		} catch (e) {
			toast.error("Couldn't delete hook", String(e));
		} finally {
			setConfirmDelete(false);
		}
	}, [hook, deleteMut, toast, navigate]);

	function toggleTool(tool: string) {
		if (coreReadOnly) return;
		mark(setTools)(
			tools.includes(tool) ? tools.filter((t) => t !== tool) : [...tools, tool],
		);
	}

	function toggleAffinity(id: string) {
		if (coreReadOnly) return;
		// Seed from the CURRENT affinity (which may include a harness the hook
		// was scoped to that isn't installed on this machine — never drop that
		// silently). Only fall back to "every installed harness" when affinity
		// was empty (i.e. currently unrestricted).
		const set = new Set(affinity.length ? affinity : installedHarnesses);
		if (set.has(id)) set.delete(id);
		else set.add(id);
		if (set.size === 0) {
			mark(setAffinity)([]);
		} else {
			mark(setAffinity)([...set]);
		}
	}

	// ─── Guards ───────────────────────────────────────────────────────────────
	if (!isNew && error) {
		return (
			<EmptyState
				icon="warning"
				title="Hook not found"
				description={`No hook named ${routeName}`}
				action={<Button onClick={() => navigate("/hooks")}>Back to hooks</Button>}
			/>
		);
	}
	if (!isNew && (isLoading || !hook)) {
		return <div className="hook-editor-loading text-dim">Loading…</div>;
	}

	const affinityAll = affinity.length === 0;
	const targeted = new Set(affinityAll ? installedHarnesses : affinity);

	return (
		<>
			<ScreenHeader
				back={{ label: "Hooks", onClick: () => navigate("/hooks") }}
				nameMono={isNew ? "new hook" : name}
				meta={
					!isNew && hook ? (
						<Tag size="sm">{hook.provenance}</Tag>
					) : (
						<Tag size="sm">user</Tag>
					)
				}
				state={dirty ? <StatePill state="unsaved">UNSAVED</StatePill> : null}
				primary={
					<Button
						variant="primary"
						icon="save"
						onClick={() => void save()}
						disabled={coreReadOnly || (!isNew && !dirty)}
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
				{coreReadOnly && (
					<div className="hook-builtin-note">
						<Icon name="link" size={12} />
						<span>
							Built-in hook — its command and event are read-only. Adjust its
							behaviour in the settings below.
						</span>
					</div>
				)}

				<div className="hook-editor-cols">
					{/* ─── Main form column ─── */}
					<div className="hook-editor-main">
						<div className="side-panel-block">
							<h4>Definition</h4>
							<MetaGrid>
								{isNew && (
									<Field label="name" full hint="lowercase, numbers, hyphens">
										<input
											value={name}
											onChange={(e) => mark(setName)(e.target.value)}
											placeholder="lint-after-edit"
											aria-label="hook name"
										/>
									</Field>
								)}
								<Field
									label="event"
									full
									hint="When this hook fires. Reach below shows which harnesses support it."
								>
									<select
										value={event}
										onChange={(e) => mark(setEvent)(e.target.value)}
										disabled={coreReadOnly}
										aria-label="event"
									>
										{CANONICAL_EVENTS.map((ev) => (
											<option key={ev} value={ev}>
												{ev}
											</option>
										))}
									</select>
								</Field>
							</MetaGrid>
							<div className="hook-event-reach">
								<span className="text-dim">reach for {event}:</span>
								<HookReachBadges capabilities={capabilities} event={event} />
							</div>
						</div>

						<div className="side-panel-block">
							<h4>Command</h4>
							<textarea
								className="hook-command-input text-mono"
								rows={2}
								value={command}
								onChange={(e) => mark(setCommand)(e.target.value)}
								readOnly={coreReadOnly}
								placeholder="npx eslint --fix $CLAUDE_FILE_PATHS"
								aria-label="command"
							/>
						</div>

						<div className="side-panel-block">
							<h4>Tools</h4>
							<p className="conn-hint">
								Match the hook to specific tools. Empty = all tools.
								{matcher && " A raw matcher below overrides this."}
							</p>
							<div className="hook-tools-picker" role="group" aria-label="Tools">
								{toolVocab.map((tool) => {
									const on = tools.includes(tool);
									return (
										<Toggle
											key={tool}
											checked={on}
											onChange={() => toggleTool(tool)}
											disabled={coreReadOnly}
											label={<span className="text-mono">{tool}</span>}
										/>
									);
								})}
							</div>
							<Field
								label="raw matcher (advanced)"
								full
								hint="A regex escape hatch — wins over the tools above."
							>
								<input
									className="text-mono"
									value={matcher}
									onChange={(e) => mark(setMatcher)(e.target.value)}
									readOnly={coreReadOnly}
									placeholder=""
									aria-label="raw matcher"
								/>
							</Field>
						</div>
					</div>

					{/* ─── Side panel ─── */}
					<div className="hook-editor-side">
						<div className="side-panel-block">
							<h4>Harness affinity</h4>
							<p className="conn-hint">
								Empty targets every effective harness. Narrow to run only on
								specific harnesses.
							</p>
							<div className="conn-affinity-chips">
								{installedHarnesses.map((id) => {
									const active = targeted.has(id);
									return (
										<button
											key={id}
											type="button"
											className="conn-harness-chip"
											data-active={active || undefined}
											aria-pressed={active}
											disabled={coreReadOnly}
											title={`${harnessLabel(id)}${active ? " — targeted" : " — excluded"}`}
											onClick={() => toggleAffinity(id)}
										>
											<HarnessGlyph id={id} size={15} decorative />
											<span>{harnessLabel(id)}</span>
										</button>
									);
								})}
								{installedHarnesses.length === 0 && (
									<span className="text-dim">no harnesses installed</span>
								)}
							</div>
						</div>

						<Field label="timeout (seconds)" full>
							<input
								type="number"
								value={timeout}
								onChange={(e) => mark(setTimeoutVal)(e.target.value)}
								readOnly={coreReadOnly}
								placeholder="60"
								aria-label="timeout"
							/>
						</Field>

						{!isNew && hook && (
							<HookSettingsSection
								hook={hook}
								projects={Object.keys(registry?.projects ?? {})}
								onSave={async (scope, settings) => {
									const res = await settingsMut.mutateAsync({
										name: hook.name,
										settings,
										global: scope === "__global__",
										project: scope === "__global__" ? undefined : scope,
									});
									if (!res.success) throw new Error(res.output);
								}}
							/>
						)}

						{!isNew && hook && !isBuiltin && (
							<div className="danger-zone">
								<h4>Danger zone</h4>
								<div className="danger-note text-dim">
									Deleting removes the definition and detaches it from every
									scope it is attached to.
								</div>
								<div className="actions">
									<Button
										variant="danger"
										icon="trash"
										onClick={() => setConfirmDelete(true)}
									>
										Delete this hook
									</Button>
								</div>
							</div>
						)}
						{!isNew && isBuiltin && (
							<div className="danger-zone">
								<h4>Danger zone</h4>
								<div className="danger-note text-dim">
									Built-ins can't be deleted — detach this hook from a scope
									instead (Attach / Detach from the palette or project card).
								</div>
							</div>
						)}
					</div>
				</div>
			</div>

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
					}
				/>
			)}
		</>
	);
}

// ─── Settings section ─────────────────────────────────────────────────────────

const GLOBAL_SCOPE = "__global__";

/**
 * Per-scope settings editor. lsp-report gets a dedicated per-language table
 * (enable + mode); every other hook gets a generic JSON editor. Built-in global
 * defaults are read-only (D1: no global override tier for built-ins) — the user
 * picks a project to override. Edits deep-merge server-side via `set-settings`.
 */
function HookSettingsSection({
	hook,
	projects,
	onSave,
}: {
	hook: HookShow;
	projects: string[];
	onSave: (scope: string, settings: Record<string, unknown>) => Promise<unknown>;
}) {
	const toast = useToast();
	const isBuiltin = hook.provenance === "builtin";
	const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
	const globalReadOnly = isBuiltin && scope === GLOBAL_SCOPE;

	// Effective settings for the chosen scope: project scope uses the merged
	// project_settings from `show` (base ⊕ override); global uses the base.
	const effective: Record<string, unknown> =
		scope === GLOBAL_SCOPE
			? hook.settings
			: (hook.project_settings[scope] ?? hook.settings);

	const isLsp = hook.name === "lsp-report";

	async function patch(delta: Record<string, unknown>) {
		if (globalReadOnly) return;
		try {
			await onSave(scope, delta);
		} catch (e) {
			toast.error("Couldn't save settings", String(e));
		}
	}

	return (
		<div className="side-panel-block hook-settings">
			<h4>Settings</h4>
			<Field label="editing settings for" full>
				<select
					value={scope}
					onChange={(e) => setScope(e.target.value)}
					aria-label="settings scope"
				>
					<option value={GLOBAL_SCOPE}>
						Global default{isBuiltin ? " (read-only)" : ""}
					</option>
					{projects.map((p) => (
						<option key={p} value={p}>
							project: {p}
						</option>
					))}
				</select>
			</Field>

			{globalReadOnly && (
				<p className="conn-hint">
					Built-in defaults are read-only. Choose a project above to override its
					per-language settings there.
				</p>
			)}

			{isLsp ? (
				<LspLanguageTable
					settings={effective}
					readOnly={globalReadOnly}
					onChangeLang={(lang, field, value) =>
						void patch({ languages: { [lang]: { [field]: value } } })
					}
				/>
			) : (
				<GenericSettingsEditor
					settings={effective}
					readOnly={globalReadOnly}
					onSave={(obj) => void patch(obj)}
				/>
			)}
		</div>
	);
}

function LspLanguageTable({
	settings,
	readOnly,
	onChangeLang,
}: {
	settings: Record<string, unknown>;
	readOnly: boolean;
	onChangeLang: (lang: string, field: "enabled" | "mode", value: unknown) => void;
}) {
	const languages = (settings.languages ?? {}) as Record<string, LspLangSettings>;
	const langNames = Object.keys(languages).sort();
	if (langNames.length === 0) {
		return <p className="text-dim">No languages configured.</p>;
	}
	return (
		<table className="lsp-lang-table" aria-label="lsp-report languages">
			<thead>
				<tr>
					<th>language</th>
					<th>enabled</th>
					<th>mode</th>
				</tr>
			</thead>
			<tbody>
				{langNames.map((lang) => {
					const cfg = languages[lang] ?? {};
					return (
						<tr key={lang}>
							<td className="text-mono">{lang}</td>
							<td>
								<Toggle
									checked={cfg.enabled !== false}
									disabled={readOnly}
									ariaLabel={`${lang} enabled`}
									onChange={(v) => onChangeLang(lang, "enabled", v)}
								/>
							</td>
							<td>
								<select
									value={cfg.mode ?? "advisory"}
									disabled={readOnly}
									aria-label={`${lang} mode`}
									onChange={(e) => onChangeLang(lang, "mode", e.target.value)}
								>
									{LSP_MODE_OPTIONS.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function GenericSettingsEditor({
	settings,
	readOnly,
	onSave,
}: {
	settings: Record<string, unknown>;
	readOnly: boolean;
	onSave: (obj: Record<string, unknown>) => void;
}) {
	const initial = useMemo(() => JSON.stringify(settings ?? {}, null, 2), [settings]);
	const [text, setText] = useState(initial);
	const [err, setErr] = useState<string | null>(null);
	const lastInitial = useRef(initial);
	// Re-sync when the underlying settings change (scope switch / refetch).
	if (lastInitial.current !== initial) {
		lastInitial.current = initial;
		setText(initial);
		setErr(null);
	}

	function save() {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text || "{}");
		} catch (e) {
			setErr(String(e));
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			setErr("Settings must be a JSON object");
			return;
		}
		setErr(null);
		onSave(parsed as Record<string, unknown>);
	}

	return (
		<Field label="settings (JSON)" full error={err ?? undefined}>
			<textarea
				className="hook-settings-json text-mono"
				rows={5}
				value={text}
				readOnly={readOnly}
				onChange={(e) => setText(e.target.value)}
				aria-label="settings JSON"
			/>
			{!readOnly && (
				<div className="actions">
					<Button size="sm" variant="soft" icon="save" onClick={save}>
						Save settings
					</Button>
				</div>
			)}
		</Field>
	);
}
