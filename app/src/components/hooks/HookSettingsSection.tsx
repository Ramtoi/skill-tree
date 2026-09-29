import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../Button";
import { Field } from "../Field";
import { Select } from "../Select";
import { SidePanelSection } from "../SidePanelSection";
import { StatePill } from "../StatePill";
import { Toggle } from "../Toggle";
import { useToast } from "../Toast";
import type { HookShow } from "@/hooks/useHooks";

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

const GLOBAL_SCOPE = "__global__";

/**
 * Per-scope settings editor, itself a `SidePanelSection` (side-panels wave 4):
 * lsp-report gets a dedicated per-language table (enable + mode); every other
 * hook gets a generic JSON editor. Built-in global defaults are read-only (D1:
 * no global override tier for built-ins) — the user picks a project to
 * override. Edits deep-merge server-side via `set-settings`.
 *
 * `primary` marks the section for a built-in, where this is the ONLY thing the
 * user can change — it must not read as another closed box (D5). It drives
 * `className="side-section-primary"` (a small ornament dot beside the title,
 * never a stripe or a skin — AUDIT M9); the `summary` string itself states
 * only the real fact about the current SCOPE (`· read-only` for a built-in's
 * global default), never a claim about the section (AUDIT M1). The summary
 * also carries an unsaved marker — plus a force-open — while the JSON draft
 * is dirty, so a staged edit can never hide inside a collapsed section (M10).
 */
export function HookSettingsSection({
	hook,
	projects,
	onSave,
	primary,
}: {
	hook: HookShow;
	projects: string[];
	onSave: (scope: string, settings: Record<string, unknown>) => Promise<unknown>;
	primary?: boolean;
}) {
	const toast = useToast();
	const isBuiltin = hook.provenance === "builtin";
	const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
	const globalReadOnly = isBuiltin && scope === GLOBAL_SCOPE;
	// Only the generic JSON editor stages a draft before saving — the LSP
	// per-language toggles/selects save on every change, so they never go dirty.
	const [dirty, setDirty] = useState(false);

	// Effective settings for the chosen scope: project scope uses the merged
	// project_settings from `show` (base ⊕ override); global uses the base.
	const effective: Record<string, unknown> =
		scope === GLOBAL_SCOPE
			? hook.settings
			: (hook.project_settings[scope] ?? hook.settings);

	const isLsp = hook.name === "lsp-report";

	const scopeOptions = useMemo(
		() => [
			{
				value: GLOBAL_SCOPE,
				label: "global default",
				hint: isBuiltin ? "read-only — pick a project to override" : undefined,
			},
			...projects.map((p) => ({ value: p, label: `project: ${p}` })),
		],
		[projects, isBuiltin],
	);
	// The real fact about the SCOPE, never a claim about the section (AUDIT
	// M1): a built-in's global scope is read-only regardless of whether this
	// section is the built-in's one editable surface (that fact belongs to
	// `primary` → `className`, not to this string).
	const scopeSummary =
		(scope === GLOBAL_SCOPE ? "global default" : `project: ${scope}`) +
		(globalReadOnly ? " · read-only" : "");

	// Re-throws on failure (after toasting) so a STAGED caller
	// (`GenericSettingsEditor`) can tell success from failure and keep its
	// draft + dirty flag on a failed save (AUDIT M2) — an unstaged caller
	// (the LSP toggles) discards the promise and never awaits the rejection.
	async function patch(delta: Record<string, unknown>): Promise<void> {
		if (globalReadOnly) return;
		try {
			await onSave(scope, delta);
		} catch (e) {
			toast.error("Couldn't save settings", String(e));
			throw e;
		}
	}

	return (
		<SidePanelSection
			id="settings"
			title="Settings"
			defaultOpen
			storageKey="st:hook-editor:sections"
			forceOpen={dirty}
			className={primary ? "side-section-primary" : undefined}
			headTitle={
				globalReadOnly
					? "Built-in defaults are read-only. Choose a project to override its per-language settings there."
					: undefined
			}
			summary={
				<>
					<span className="text-dim">{scopeSummary}</span>
					{dirty && <StatePill state="unsaved">unsaved</StatePill>}
				</>
			}
		>
			<div className="kv">
				<div className="kv-row">
					<dt>scope</dt>
					<dd>
						<Select
							value={scope}
							label="settings scope"
							options={scopeOptions}
							onChange={setScope}
						/>
					</dd>
				</div>
			</div>

			{isLsp ? (
				<LspSettingsTable
					settings={effective}
					readOnly={globalReadOnly}
					onChangeLang={(lang, field, value) =>
						// Already toasted inside `patch`; nothing here stages a draft,
						// so there is no dirty flag to keep — just swallow the (now
						// re-thrown) rejection so it isn't reported as unhandled.
						void patch({ languages: { [lang]: { [field]: value } } }).catch(() => {})
					}
				/>
			) : (
				<GenericSettingsEditor
					settings={effective}
					readOnly={globalReadOnly}
					onSave={(obj) => patch(obj)}
					onDirtyChange={setDirty}
				/>
			)}
		</SidePanelSection>
	);
}

export function LspSettingsTable({
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
								<Select
									value={cfg.mode ?? "advisory"}
									label={`${lang} mode`}
									options={LSP_MODE_OPTIONS}
									disabled={readOnly}
									onChange={(v) => onChangeLang(lang, "mode", v)}
								/>
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
	onDirtyChange,
}: {
	settings: Record<string, unknown>;
	readOnly: boolean;
	/** Resolves on a successful save, rejects (already toasted) on failure —
	 *  `save()` below needs to tell the two apart to know whether to clear
	 *  the dirty flag (AUDIT M2). */
	onSave: (obj: Record<string, unknown>) => Promise<void>;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const initial = useMemo(() => JSON.stringify(settings ?? {}, null, 2), [settings]);
	const [text, setText] = useState(initial);
	const [err, setErr] = useState<string | null>(null);
	// Dirty is its OWN flag, not `text !== initial` (AUDIT M2): `hook_set_settings`
	// deep-merges server-side, so a save whose only change is a REMOVED key is a
	// legitimate server-side no-op — `hook.settings` refetches byte-identical,
	// `initial` never changes, and a comparison-only dirty flag would then stay
	// true forever with no way for the user to clear it.
	const [dirtyFlag, setDirtyFlag] = useState(false);
	const lastInitial = useRef(initial);
	// Re-sync when the underlying settings change (scope switch / refetch).
	if (lastInitial.current !== initial) {
		lastInitial.current = initial;
		setText(initial);
		setErr(null);
		setDirtyFlag(false);
	}

	// Report dirtiness to the parent (its SidePanelSection summary/force-open)
	// from an effect, never during render — `onDirtyChange` is the PARENT's
	// setState, and calling it while THIS component renders is exactly the
	// "setState during a different component's render" React forbids.
	useEffect(() => {
		onDirtyChange?.(dirtyFlag);
	}, [dirtyFlag, onDirtyChange]);

	// A stale `true` must never survive this editor unmounting — switching
	// between a non-lsp hook and lsp-report swaps this component out for
	// `LspSettingsTable`, which never dirties, and nothing else would ever
	// clear the parent's flag (AUDIT M2). `onDirtyChange` is
	// `HookSettingsSection`'s `setDirty`, a stable setState identity — this
	// must run exactly once on unmount, not re-arm on every dirty flip.
	useEffect(() => {
		return () => onDirtyChange?.(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function change(next: string) {
		setText(next);
		setDirtyFlag(next !== initial);
	}

	async function save() {
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
		try {
			await onSave(parsed as Record<string, unknown>);
			// Clear on the SAVE succeeding, not on `initial` eventually diverging
			// — for a no-op merge it never will.
			setDirtyFlag(false);
		} catch {
			// Already toasted by the caller; keep the draft (and the flag) so the
			// user can retry instead of retyping.
		}
	}

	return (
		<Field label="settings (JSON)" full error={err ?? undefined}>
			<textarea
				className="hook-settings-json text-mono"
				rows={5}
				value={text}
				readOnly={readOnly}
				onChange={(e) => change(e.target.value)}
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
