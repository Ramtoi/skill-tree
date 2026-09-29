// Wave 4c unit 2 (plans/3.md §2.1/§3.1/§6.5) — the collapsed "New hook…"
// disclosure form inside `CompanionsEditSheet`'s HOOKS group. Four fields,
// fixed: name, event, tools, activation — no matcher/harness/script-mode
// (those stay library-hook concerns; a skill-shipped hook that needs them is
// better authored as a library hook and referenced with `{ref}`, which the
// sheet already supports). The script path is DERIVED, never asked for — the
// one input that could otherwise escape the skill dir.
//
// Owns no IPC: `onAdd` hands the fully-formed inline hook (including the
// `scaffold` key the `set` body needs, §6.2) up to the sheet, which stages it
// into the draft and folds `scaffold` back in at Save — mirroring how
// `agents[].from` rides alongside the draft in a side map (D9's `addedFrom`),
// never inside the shared `CompanionsDraft` shape itself.

import { useState } from "react";
import { Button } from "@/components/Button";
import { ChipRadios } from "@/components/ChipRadios";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { ToolPicker } from "@/components/ToolPicker";
import { CANONICAL_EVENTS, EVENT_HINTS, hookToolGroups } from "@/lib/hookCatalog";
import {
	defaultHookScriptPath,
	validateNewHook,
	type CompanionActivation,
	type NewHookTaken,
	type ShipsWithHook,
	type ShipsWithHookScaffold,
} from "@/lib/companions";
import type { Registry } from "@/types";

const EVENT_OPTIONS = CANONICAL_EVENTS.map((ev) => ({
	value: ev,
	label: ev,
	hint: EVENT_HINTS[ev],
}));

const ACTIVATION_OPTIONS: { value: CompanionActivation; label: string }[] = [
	{ value: "while-running", label: "While running" },
	{ value: "always", label: "Always" },
];

export interface NewHookFormProps {
	registry: Registry | undefined;
	/** §6.3a `HOOK_NAME_TAKEN`, split by source — see `validateNewHook`. */
	taken: NewHookTaken;
	/** Fires once, with the fully-formed inline hook (a fixed `scaffold:
	 *  {template: "bash"}` — the derived path always ends `.sh`). The form
	 *  clears itself right after, so a later reopen always starts fresh. */
	onAdd: (hook: ShipsWithHook & { scaffold: ShipsWithHookScaffold }) => void;
}

type FieldError = { field: "name" | "event"; message: string } | null;

/**
 * The sheet's collapsed new-hook form. Validation is against the shared
 * §6.3a name-taken set via `validateNewHook` — the SAME check
 * `_apply_set_body`'s inline arm and `cmd_companions_new_hook` enforce
 * server-side, so `Add` can never stage a body the CLI will bounce.
 */
export function NewHookForm({ registry, taken, onAdd }: NewHookFormProps) {
	const [name, setName] = useState("");
	const [event, setEvent] = useState<string>(CANONICAL_EVENTS[0]);
	const [tools, setTools] = useState<string[]>([]);
	const [activation, setActivation] = useState<CompanionActivation>("while-running");
	const [error, setError] = useState<FieldError>(null);

	const draft = { name, event, tools, activation };
	const validation = validateNewHook(draft, taken);
	const path = defaultHookScriptPath(name);
	const toolGroups = hookToolGroups(registry);

	function handleAdd() {
		const result = validateNewHook(draft, taken);
		if (!result.ok) {
			setError({ field: result.field, message: result.message });
			return;
		}
		const command = defaultHookScriptPath(name);
		if (!command) {
			setError({ field: "name", message: "Name the hook." });
			return;
		}
		onAdd({
			name: name.trim(),
			event,
			...(tools.length > 0 ? { tools } : {}),
			command,
			activation,
			scaffold: { template: "bash" },
		});
		setName("");
		setEvent(CANONICAL_EVENTS[0]);
		setTools([]);
		setActivation("while-running");
		setError(null);
	}

	return (
		<div className="companions-edit-newhook-form">
			<Field label="Name" htmlFor="companions-new-hook-name">
				<input
					id="companions-new-hook-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="scope-guard"
					data-testid="companions-new-hook-name"
				/>
			</Field>
			<Field label="Event" hint="The Harnesses panel shows which harnesses support it.">
				<div data-testid="companions-new-hook-event">
					<Select value={event} label="Event" options={EVENT_OPTIONS} onChange={setEvent} />
				</div>
			</Field>
			<ToolPicker value={tools} onChange={setTools} groups={toolGroups} />
			<div data-testid="companions-new-hook-activation">
				<ChipRadios
					name="companions-new-hook-activation"
					label="Activation"
					value={activation}
					options={ACTIVATION_OPTIONS}
					onChange={setActivation}
				/>
			</div>
			{path && (
				<p
					className="companions-edit-newhook-path text-mono text-dim"
					data-testid="companions-new-hook-path"
				>
					Creates {path} and marks it executable.
				</p>
			)}
			{error && (
				<p
					className="companions-edit-newhook-error"
					role="alert"
					data-testid="companions-new-hook-error"
				>
					{error.message}
				</p>
			)}
			<Button
				variant="ghost"
				size="sm"
				onClick={handleAdd}
				disabled={!validation.ok}
				data-testid="companions-new-hook-add"
			>
				Add
			</Button>
		</div>
	);
}
