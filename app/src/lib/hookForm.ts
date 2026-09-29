// ─── Hook editor form derivations (hook-editor-redesign D2/D3/D4) ────────────
// The registry model is unchanged (tools[] + matcher string, command OR script).
// The redesigned editor presents two SEGMENTED modes over that model, so the
// mode must be DERIVED from the data on hydration rather than stored — a hook
// edited by `hub hook edit` (or hand-written into registry.yaml) has to open in
// the mode that honestly describes it. Pure functions live here so the mapping
// is testable without mounting the screen.

import { harnessLabel } from "@/components/harness/harnessRegistry";
import type { HookDefinition, HookDoctorFinding, HookScriptSpec } from "@/hooks/useHooks";

// ─── Applies-to (D2) ─────────────────────────────────────────────────────────

export type AppliesMode = "all" | "tools" | "matcher";

/**
 * Which "APPLIES TO" mode a definition opens in.
 *
 * `matcher` WINS over `tools` — that is the backend's precedence
 * (`_resolve_matcher` uses the raw matcher and ignores the tool list), so a
 * legacy definition carrying BOTH must open in Raw matcher mode. Opening it in
 * Specific-tools mode would show a tool list that does not actually control when
 * the hook fires.
 */
export function deriveAppliesMode(input: {
	tools?: string[] | null;
	matcher?: string | null;
}): AppliesMode {
	if (input.matcher && input.matcher.trim()) return "matcher";
	if (input.tools && input.tools.length > 0) return "tools";
	return "all";
}

/** True when a definition carries BOTH a matcher and tools (legacy shape): the
 *  tools are inert and the editor says so instead of quietly dropping them. */
export function hasLegacyBothMatcherAndTools(input: {
	tools?: string[] | null;
	matcher?: string | null;
}): boolean {
	return !!(input.matcher?.trim() && (input.tools?.length ?? 0) > 0);
}

// ─── Action (D3) ─────────────────────────────────────────────────────────────

export type ActionMode = "command" | "managed" | "repo";
export type Interpreter = "bash" | "python3";

export const INTERPRETERS: Interpreter[] = ["bash", "python3"];

/**
 * Which "ACTION" mode a definition opens in. `script` wins when present — the
 * backend treats `command` + `script` as invalid and lets `command` win on load,
 * but new/edit refuse to create that state, so a definition that HAS a script is
 * a script hook.
 */
export function deriveActionMode(input: {
	command?: string | null;
	script?: HookScriptSpec | null;
}): ActionMode {
	const src = input.script?.source;
	if (src === "managed") return "managed";
	if (src === "repo") return "repo";
	return "command";
}

/** Coerce an unknown interpreter string (registry drift) to a supported one. */
export function normalizeInterpreter(value: string | undefined | null): Interpreter {
	return value === "python3" ? "python3" : "bash";
}

// NOTE: there is deliberately NO helper that composes a managed script's path.
// The hooks dir hangs off `data_home()` — `$SKILL_HUB_HOME`, `$SKILL_HUB_DIR`,
// or a legacy `~/Dev/.skill-hub/` — so anything assembled here is a guess, and
// the guess was being shown inside a "this will be deleted" confirm. The only
// honest sources are `hook script show --json`'s `path` (a real file) or prose.

/** Default seed body for a fresh managed script (mirrors the CLI's stub). */
export function managedScriptStub(interpreter: Interpreter): string {
	return interpreter === "python3"
		? "#!/usr/bin/env python3\n# Hook script — stdin carries the harness event JSON.\n"
		: "#!/usr/bin/env bash\n# Hook script — stdin carries the harness event JSON.\n";
}

/**
 * Validate a REPO script path. The backend requires a relative POSIX path with
 * no `..` traversal; catching it here turns an opaque CLI rejection into an
 * inline field error the user can act on.
 *
 * Returns null when valid, otherwise the message to show.
 */
export function validateRepoScriptPath(path: string): string | null {
	const p = path.trim();
	if (!p) return "A script path is required";
	if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
		return "Use a path relative to the project root (no leading /)";
	}
	if (p.startsWith("~")) return "Use a path relative to the project root (no ~)";
	if (p.includes("\\")) return "Use forward slashes (/) in the path";
	if (p.split("/").some((seg) => seg === "..")) {
		return "The path may not escape the project root (no ..)";
	}
	return null;
}

// ─── Live summary line (D4) ──────────────────────────────────────────────────

export interface HookSummaryInput {
	event: string;
	appliesMode: AppliesMode;
	tools: string[];
	matcher: string;
	actionMode: ActionMode;
	scriptPath?: string;
	/** Harness affinity; empty = every effective harness. */
	affinity: string[];
	/** The built-in's action is a read-only shipped script, not a shell
	 *  command — pass `hook?.provenance === "builtin"` so the summary says so
	 *  instead of the generic (and here, wrong) "runs a shell command". */
	builtin?: boolean;
}

/** How many tool names the summary spells out before collapsing to `+N`. */
const SUMMARY_TOOLS_SHOWN = 2;

/**
 * The "what did I just build" anchor rendered under the screen header, e.g.
 * `On PostToolUse · Edit, Write +1 · runs a managed script · Claude Code, Codex`.
 * Recomputed from form state on every change — never from the server copy, so it
 * describes the definition the user is ABOUT to save.
 */
export function hookSummary(input: HookSummaryInput): string {
	const parts: string[] = [`On ${input.event || "—"}`];

	if (input.appliesMode === "matcher") {
		parts.push(input.matcher.trim() ? `matching /${input.matcher.trim()}/` : "matching /…/");
	} else if (input.appliesMode === "tools" && input.tools.length > 0) {
		const shown = input.tools.slice(0, SUMMARY_TOOLS_SHOWN).join(", ");
		const extra = input.tools.length - SUMMARY_TOOLS_SHOWN;
		parts.push(extra > 0 ? `${shown} +${extra}` : shown);
	} else {
		parts.push("all tools");
	}

	if (input.actionMode === "managed") parts.push("runs a managed script");
	else if (input.actionMode === "repo") {
		const p = input.scriptPath?.trim();
		parts.push(p ? `runs the repo script ${p}` : "runs a repo script");
	} else if (input.builtin) parts.push("runs a built-in script");
	else parts.push("runs a shell command");

	parts.push(
		input.affinity.length === 0
			? "every effective harness"
			: input.affinity.map((id) => harnessLabel(id)).join(", "),
	);

	return parts.join(" · ");
}

/**
 * A baked command with every absolute path reduced to its basename, so a row
 * can show `python3 lsp_report.py --config lsp-report.global.json` instead of
 * three quoted `/Applications/Skill Tree.app/…` paths that push the script
 * name off the line. Single-quoted tokens (shlex.quote output) are honoured.
 * The row's `title` still carries the full baked string.
 */
export function compactCommand(command: string): string {
	const tokens = command.match(/'(?:[^'\\]|\\.)*'|\S+/g) ?? [];
	return tokens
		.map((tok) => {
			const quoted = tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2;
			const raw = quoted ? tok.slice(1, -1) : tok;
			if (!raw.startsWith("/")) return tok;
			const base = raw.slice(raw.lastIndexOf("/") + 1);
			return base || tok;
		})
		.join(" ");
}

/**
 * The library row's "runs" line: what actually executes, in ONE glance —
 * a command hook's raw command, a managed/repo script's baked interpreter +
 * path (+ args), or an em dash for a definition with neither. Pure over the
 * definition shape so the row and its test agree on exactly one source of
 * truth (hooks-screen-polish Wave A).
 *
 * A built-in's `command` is only a template (sync bakes the real one) — pass
 * `provenance`/`baked_command` (both on `HookRow`/`HookShow`) so a built-in
 * row shows the truth instead. A non-built-in ignores both and keeps the
 * short command/script form.
 */
export function hookRunsLine(def: {
	command?: string | null;
	script?: HookDefinition["script"] | null;
	provenance?: HookDefinition["provenance"];
	baked_command?: string | null;
}): string {
	if (def.provenance === "builtin" && def.baked_command) {
		return compactCommand(def.baked_command);
	}
	const script = def.script;
	const args = script?.args?.trim();
	if (script?.source === "managed") {
		const ext = script.interpreter === "python3" ? "py" : "sh";
		return `${script.interpreter} script.${ext}${args ? ` ${args}` : ""}`;
	}
	if (script?.source === "repo") {
		return `${script.interpreter} ${script.path ?? ""}${args ? ` ${args}` : ""}`;
	}
	const command = def.command?.trim();
	return command ? command : "—";
}

// ─── Health (Wave C) ───────────────────────────────────────────────────────────

/** Doctor findings scoped to one hook, plus the worst severity a badge should
 *  show. `worst: null` (empty `items`) means the row renders no badge at all. */
export interface HookHealth {
	worst: "danger" | "warning" | "info" | null;
	count: number;
	items: HookDoctorFinding[];
}

const SEVERITY_RANK: Record<HookDoctorFinding["severity"], number> = {
	danger: 0,
	warning: 1,
	info: 2,
};

/** Aggregate `hub hook doctor --json`'s findings down to one hook, sorted
 *  worst-first (ties broken by code) so `items[0]` is always the worst. */
export function hookHealth(
	findings: HookDoctorFinding[] | undefined,
	name: string,
): HookHealth {
	const items = (findings ?? [])
		.filter((f) => f.hook === name)
		.slice()
		.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code));
	if (items.length === 0) return { worst: null, count: 0, items: [] };
	return { worst: items[0].severity, count: items.length, items };
}

/** `--red`/`--amber`/`--blue` channel for a health badge, keyed the same way as
 *  the schema's severity. */
export function hookHealthChannel(
	severity: HookDoctorFinding["severity"],
): "error" | "warn" | "info" {
	if (severity === "danger") return "error";
	if (severity === "warning") return "warn";
	return "info";
}

/** Badge text: `"1 warning"` when every finding shares a severity, `"N
 *  findings"` once the worst mixes with a lesser one — the count still matters,
 *  but naming one severity for a mixed bag would misstate the others. */
export function hookHealthLabel(health: HookHealth): string {
	if (health.worst === null) return "";
	const uniform = health.items.every((f) => f.severity === health.worst);
	if (uniform) return `${health.count} ${health.worst}${health.count > 1 ? "s" : ""}`;
	return `${health.count} findings`;
}
