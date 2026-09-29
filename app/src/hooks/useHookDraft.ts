import { useCallback, useEffect, useRef, useState } from "react";
import { CANONICAL_EVENTS } from "@/lib/hookCatalog";
import {
	deriveActionMode,
	deriveAppliesMode,
	normalizeInterpreter,
	type ActionMode,
	type AppliesMode,
	type Interpreter,
} from "@/lib/hookForm";
import type { HookScriptShow, HookShow } from "@/hooks/useHooks";

export interface HookDraft {
	name: string;
	setName: (v: string) => void;
	description: string;
	setDescription: (v: string) => void;
	event: string;
	setEvent: (v: string) => void;
	command: string;
	setCommand: (v: string) => void;
	actionMode: ActionMode;
	setActionMode: (v: ActionMode) => void;
	interpreter: Interpreter;
	setInterpreter: (v: Interpreter) => void;
	scriptPath: string;
	setScriptPath: (v: string) => void;
	scriptArgs: string;
	setScriptArgs: (v: string) => void;
	scriptBody: string;
	setScriptBody: (v: string) => void;
	scriptBodyDirty: boolean;
	setScriptBodyDirty: (v: boolean) => void;
	appliesMode: AppliesMode;
	setAppliesMode: (v: AppliesMode) => void;
	tools: string[];
	setTools: (v: string[]) => void;
	matcher: string;
	setMatcher: (v: string) => void;
	timeout: string;
	setTimeoutVal: (v: string) => void;
	affinity: string[];
	setAffinity: (v: string[]) => void;
	dirty: boolean;
	setDirty: (v: boolean) => void;
	/** Wraps a setter so any core-field edit also flips `dirty`. */
	mark: <T>(setter: (v: T) => void) => (v: T) => void;
	anythingDirty: boolean;
	/** Identity stamp of the hook the in-memory script buffer belongs to — read
	 *  by the save path to refuse writing an unowned buffer (see the body
	 *  hydration effect below). */
	bodyHydratedFor: React.MutableRefObject<string | null>;
	/** Clears both dirty flags after a successful save. */
	reset: () => void;
}

/**
 * Owns the hook editor's 16 core-field form state plus the identity-keyed
 * hydration that fills it from the loaded definition (and its managed script
 * body). Hydration is keyed on hook IDENTITY — not the react-query object —
 * because every hook mutation invalidates the whole `["hooks"]` key
 * (`useHooks.invalidateHooks`): a sibling mutation on the SAME hook (notably
 * "Save settings" in the side panel) refetches `hook_show` and hands back a
 * NEW object whose contents changed, which unconditional hydration would use
 * to silently overwrite the user's in-progress edits and clear the UNSAVED
 * pill. Mirrors the identity-stamp guard in the Snippets editor (`loadedFor`)
 * and SkillEditor's route-keyed body load.
 *
 * `hydratedFor`/`bodyHydratedFor`/`dirtyRef`/`bodyDirtyRef` move together with
 * their two hydration effects — splitting them breaks the guard (a sibling
 * mutation would clobber in-progress edits).
 */
export function useHookDraft(args: {
	hook: HookShow | undefined;
	isNew: boolean;
	routeName: string | undefined;
	scriptPayload: HookScriptShow | null | undefined;
}): HookDraft {
	const { hook, isNew, routeName, scriptPayload } = args;

	// ─── Core-field form state ────────────────────────────────────────────────
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [event, setEvent] = useState<string>(CANONICAL_EVENTS[1]); // PostToolUse
	const [command, setCommand] = useState("");
	const [actionMode, setActionMode] = useState<ActionMode>("command");
	const [interpreter, setInterpreter] = useState<Interpreter>("bash");
	const [scriptPath, setScriptPath] = useState("");
	const [scriptArgs, setScriptArgs] = useState("");
	const [scriptBody, setScriptBody] = useState("");
	const [scriptBodyDirty, setScriptBodyDirty] = useState(false);
	const [appliesMode, setAppliesMode] = useState<AppliesMode>("all");
	const [tools, setTools] = useState<string[]>([]);
	const [matcher, setMatcher] = useState("");
	const [timeout, setTimeoutVal] = useState<string>("");
	const [affinity, setAffinity] = useState<string[]>([]);
	const [dirty, setDirty] = useState(false);

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
	const bodyHydratedFor = useRef<string | null>(null);
	// The live dirty flags, readable inside the hydration effects WITHOUT being a
	// dependency: a dirty→false flip (e.g. right after a save) must not re-run
	// hydration against a not-yet-refetched definition.
	const dirtyRef = useRef(false);
	dirtyRef.current = dirty;
	const bodyDirtyRef = useRef(false);
	bodyDirtyRef.current = scriptBodyDirty;

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
		setDescription(hook.description || "");
		setEvent(hook.event || CANONICAL_EVENTS[1]);
		setCommand(hook.command || "");
		setTools(hook.tools ?? []);
		setMatcher(hook.matcher || "");
		setTimeoutVal(hook.timeout != null ? String(hook.timeout) : "");
		setAffinity(hook.harnesses ?? []);
		setAppliesMode(deriveAppliesMode(hook));
		setActionMode(deriveActionMode(hook));
		setInterpreter(normalizeInterpreter(hook.script?.interpreter));
		setScriptPath(hook.script?.path ?? "");
		setScriptArgs(hook.script?.args ?? "");
		setDirty(false);
	}, [hook, isNew, routeName]);

	// Hydrate the managed script body — same identity+dirty guard, its own stamp
	// so a body edit survives a definition refetch and vice versa.
	useEffect(() => {
		if (isNew) return;
		const identity = routeName ?? "";
		// The route moved to a DIFFERENT hook. The buffer still in state belongs to
		// the previous one, and `App.tsx` renders this screen without a route key,
		// so nothing remounts it away. Drop the stale buffer FIRST — before the
		// `!payload` bail, which is permanent for a hook whose script query is
		// disabled (a command hook never fetches a body). Leaving it would let the
		// previous hook's script show up here, keep the UNSAVED pill lit on a hook
		// the user never touched, and — on ⌘S — write hook A's script into hook B.
		if (bodyHydratedFor.current !== identity) {
			bodyHydratedFor.current = identity;
			setScriptBody("");
			setScriptBodyDirty(false);
			// The ref mirrors the live flag and is only refreshed on the next
			// render; the reset above has to be visible to the check below in THIS
			// pass, or a cached payload would be skipped and never re-tried (the
			// deps don't change again).
			bodyDirtyRef.current = false;
		}
		const payload = scriptPayload;
		if (!payload) return;
		if (bodyDirtyRef.current) return;
		setScriptBody(payload.body ?? "");
		setScriptBodyDirty(false);
	}, [scriptPayload, isNew, routeName]);

	const mark = useCallback(<T,>(setter: (v: T) => void) => {
		return (v: T) => {
			setter(v);
			setDirty(true);
		};
	}, []);

	const reset = useCallback(() => {
		setDirty(false);
		setScriptBodyDirty(false);
	}, []);

	return {
		name,
		setName,
		description,
		setDescription,
		event,
		setEvent,
		command,
		setCommand,
		actionMode,
		setActionMode,
		interpreter,
		setInterpreter,
		scriptPath,
		setScriptPath,
		scriptArgs,
		setScriptArgs,
		scriptBody,
		setScriptBody,
		scriptBodyDirty,
		setScriptBodyDirty,
		appliesMode,
		setAppliesMode,
		tools,
		setTools,
		matcher,
		setMatcher,
		timeout,
		setTimeoutVal,
		affinity,
		setAffinity,
		dirty,
		setDirty,
		mark,
		anythingDirty: dirty || scriptBodyDirty,
		bodyHydratedFor,
		reset,
	};
}
