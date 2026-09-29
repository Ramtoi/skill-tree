import { Button } from "./Button";
import { ChipRadios } from "./ChipRadios";
import { CodeAreaEdit } from "./CodeArea";
import { Field } from "./Field";
import { Select } from "./Select";
import { StatusBadge } from "./StatusBadge";
import { SourceViewer } from "./hooks/SourceViewer";
import type {
	HookCommandScript,
	HookCommandScriptLocation,
	HookRepoScriptConversion,
	HookScriptProject,
} from "@/hooks/useHooks";
import {
	INTERPRETERS,
	validateRepoScriptPath,
	type ActionMode,
	type Interpreter,
} from "@/lib/hookForm";

export interface HookActionEditorProps {
	mode: ActionMode;
	onModeChange: (m: ActionMode) => void;

	command: string;
	onCommandChange: (v: string) => void;

	interpreter: Interpreter;
	onInterpreterChange: (v: Interpreter) => void;
	scriptPath: string;
	onScriptPathChange: (v: string) => void;
	scriptArgs: string;
	onScriptArgsChange: (v: string) => void;

	/** Managed-script body (edited in place; `⌘S` saves it with the form). */
	body: string;
	onBodyChange: (v: string) => void;
	bodyLoading?: boolean;
	/** True when the managed script file is absent on disk (sync skips the hook). */
	bodyMissing?: boolean;

	/** Repo scripts: per-attached-project existence from `hook show --json`. */
	scriptProjects?: HookScriptProject[];
	/** Absolute path of the existing managed script, from the backend. Absent
	 *  until it exists on disk (create mode) — there is no composed stand-in: the
	 *  hooks dir follows `data_home()`, so a frontend guess can name a file that
	 *  does not exist. */
	managedPath?: string;
	/** The command line the harness actually receives after sync, from
	 *  `hook show --json`'s `baked_command`. Absent in create mode (nothing to
	 *  bake yet) — the hint keeps its current copy then. */
	bakedCommand?: string | null;

	/** Command mode only: the script a plain command's command line references,
	 *  from `hook show --json`'s `command_script`. `null`/absent renders none of
	 *  the "Script file" block. */
	commandScript?: HookCommandScript | null;
	/** Command mode only: a convertible `<interpreter> <repo path> [args]`
	 *  command, from `repo_script_conversion`. `null`/absent shows no convert
	 *  offer. */
	conversion?: HookRepoScriptConversion | null;
	/** Reveals a path in Finder — the app never `openPath`s a script (macOS
	 *  opens `.sh` with Terminal, which EXECUTES it). */
	onReveal?: (path: string) => void;
	/** Fills the form from `conversion` and switches to Repo script mode. */
	onConvert?: () => void;
	/** The hook's route name — namespaces `SourceViewer`'s reset so switching
	 *  hooks never leaves a stale tab selected. */
	hookName?: string;

	readOnly?: boolean;
}

/** Text for a `command_script` location whose body isn't shown — honours
 *  `reason` instead of collapsing every non-body case into one generic line. */
function commandScriptMissingText(loc: HookCommandScriptLocation): string {
	switch (loc.reason) {
		case "outside_project":
			return `Resolves outside ${loc.project ?? "the project"} — not shown.`;
		case "unreadable":
			return "Could not read the file.";
		case "too_large":
			return "Too large to show (over 512 KiB).";
		case "unresolvable":
			return "Path could not be resolved.";
		default:
			return loc.project ? `Not present in ${loc.project}.` : "File not found.";
	}
}

const MODES: { id: ActionMode; label: string }[] = [
	{ id: "command", label: "Shell command" },
	{ id: "managed", label: "Managed script" },
	{ id: "repo", label: "Repo script" },
];

const INTERPRETER_OPTIONS = INTERPRETERS.map((i) => ({ value: i, label: i }));

/**
 * The ACTION section (hook-editor-redesign D3). One segmented control over three
 * mutually-exclusive shapes of the same field: a shell command, a hub-managed
 * script (project-agnostic, edited right here), or a script that lives inside
 * each project the hook is attached to.
 *
 * The mode is DERIVED from the definition on hydration (`deriveActionMode`) —
 * nothing stores it — so a hook edited outside the app always opens in the mode
 * that honestly describes what it runs.
 */
export function HookActionEditor(props: HookActionEditorProps) {
	const {
		mode,
		onModeChange,
		command,
		onCommandChange,
		interpreter,
		onInterpreterChange,
		scriptPath,
		onScriptPathChange,
		scriptArgs,
		onScriptArgsChange,
		body,
		onBodyChange,
		bodyLoading,
		bodyMissing,
		scriptProjects,
		managedPath,
		bakedCommand,
		commandScript,
		conversion,
		onReveal,
		onConvert,
		hookName,
		readOnly,
	} = props;

	const pathError = mode === "repo" && scriptPath.trim() ? validateRepoScriptPath(scriptPath) : null;

	return (
		<div className="hook-action">
			{!readOnly && (
				<div className="hook-action-modes">
					<ChipRadios
						name="hook-action-mode"
						label="Action type"
						value={mode}
						options={MODES.map((m) => ({ value: m.id, label: m.label }))}
						onChange={onModeChange}
					/>
				</div>
			)}

			{mode === "command" && (
				<>
					<textarea
						className="hook-command-input text-mono"
						rows={2}
						value={command}
						onChange={(e) => onCommandChange(e.target.value)}
						readOnly={readOnly}
						placeholder="npx eslint --fix $CLAUDE_FILE_PATHS"
						aria-label="command"
					/>
					<p className="conn-hint">
						Run verbatim by the harness from the project root when the event fires.
					</p>
					{conversion && !readOnly && (
						<div className="conn-hint hook-repo-convert">
							This command runs a script inside the project. As a repo script it
							gets per-project presence checks, a doctor finding when it is
							missing, and a shell-quoted path.
							<div className="actions">
								<Button size="sm" variant="soft" onClick={onConvert}>
									Convert to repo script
								</Button>
							</div>
						</div>
					)}
					{commandScript && (
						<Field label="script file" full>
							<div className="hook-command-script">
								{commandScript.locations.map((loc, i) => {
									const label = loc.project ?? commandScript.kind;
									return (
										<div
											className="hook-command-script-row"
											key={`${label}-${i}`}
										>
											<span className={loc.project ? "text-mono" : "text-dim"}>
												{label}
											</span>
											<span
												className="text-mono hook-command-script-path"
												title={loc.path}
											>
												{loc.path}
											</span>
											<StatusBadge
												channel={loc.exists ? "ok" : "warn"}
												shape="dot"
												ariaLabel={`${label}: ${loc.exists ? "script exists" : "script missing"}`}
											>
												{loc.exists ? "exists" : "missing"}
											</StatusBadge>
											{loc.exists && onReveal && (
												<Button
													size="sm"
													icon="folder"
													onClick={() => onReveal(loc.path)}
												>
													Reveal
												</Button>
											)}
										</div>
									);
								})}
								<SourceViewer
									files={commandScript.locations.map((loc, i) => ({
										id: `${loc.project ?? commandScript.kind}-${i}`,
										label: loc.project ?? commandScript.kind,
										body: loc.body,
										missingText: commandScriptMissingText(loc),
									}))}
									idPrefix="hook-command-source"
									ariaLabel="Command script source"
									resetKey={hookName}
								/>
							</div>
						</Field>
					)}
				</>
			)}

			{mode !== "command" && (
				<div className="hook-script-meta">
					<Field label="interpreter" full>
						<Select
							value={interpreter}
							label="script interpreter"
							options={INTERPRETER_OPTIONS}
							disabled={readOnly}
							onChange={(v) => onInterpreterChange(v as Interpreter)}
						/>
					</Field>
					{mode === "repo" && (
						<Field
							label="script path"
							full
							error={pathError ?? undefined}
							hint="Relative to the project root, e.g. scripts/lint.sh"
						>
							<input
								className="text-mono"
								value={scriptPath}
								onChange={(e) => onScriptPathChange(e.target.value)}
								readOnly={readOnly}
								placeholder="scripts/lint.sh"
								aria-label="script path"
							/>
						</Field>
					)}
					<Field
						label="args (optional)"
						full
						hint="Appended verbatim to the command line."
					>
						<input
							className="text-mono"
							value={scriptArgs}
							onChange={(e) => onScriptArgsChange(e.target.value)}
							readOnly={readOnly}
							placeholder="--fix"
							aria-label="script args"
						/>
					</Field>
				</div>
			)}

			{mode === "managed" && (
				<div className="hook-script-managed">
					<p className="conn-hint">
						Stored in Skill Tree, project-agnostic.{" "}
						{bakedCommand ? (
							<>
								Synced as:{" "}
								<span className="text-mono">{bakedCommand}</span>
							</>
						) : managedPath ? (
							<>
								Synced by absolute path:{" "}
								<span className="text-mono">{managedPath}</span>
							</>
						) : (
							"Its file is created — and its path assigned — when you save."
						)}
					</p>
					{bodyMissing && (
						<p className="conn-hint hook-script-warn">
							The script file is missing on disk — sync skips this hook until it is
							saved again.
						</p>
					)}
					<div className="hook-script-body">
						{bodyLoading ? (
							<div className="text-dim hook-script-loading">Loading script…</div>
						) : readOnly ? (
							<pre className="text-mono hook-script-readonly">{body}</pre>
						) : (
							<CodeAreaEdit content={body} onChange={onBodyChange} />
						)}
					</div>
				</div>
			)}

			{mode === "repo" && (
				<div className="hook-script-repo">
					<p className="conn-hint">
						Lives inside each project this hook is attached to; runs from the project
						root.
					</p>
					{bakedCommand && (
						<p className="conn-hint">
							Synced as: <span className="text-mono">{bakedCommand}</span>
						</p>
					)}
					{scriptProjects && scriptProjects.length > 0 && (
						<div className="hook-script-projects" aria-label="Script presence per project">
							{scriptProjects.map((p) => (
								<div className="hook-script-project" key={p.project}>
									<span className="text-mono">{p.project}</span>
									<StatusBadge
										channel={p.path_exists ? "ok" : "warn"}
										shape="dot"
										ariaLabel={`${p.project}: ${p.path_exists ? "script exists" : "script missing"}`}
									>
										{p.path_exists ? "exists" : "missing"}
									</StatusBadge>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
