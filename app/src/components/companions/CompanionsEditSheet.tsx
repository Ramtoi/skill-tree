// D10/Approach 9 (wave C) — the rare-path editor for a skill's `ships_with`
// block. Three staged pickers (agents/hooks as `MultiSelectList`s, rules as a
// typed add row) write to a local draft only; nothing is provisioned until
// ONE `hub skill companions set --json-body` call on Save (D10/I6). Before
// that call, every companion the draft is about to drop gets its own
// de-provision line, read from the registry's ledger via
// `lib/companions.ts`'s `removalConsequences` (W12) — so a deselect never
// surprises the user about what it will do on the next reconcile.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, Sheet } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { ChipRadios } from "@/components/ChipRadios";
import { Icon } from "@/components/Icon";
import { MultiSelectList, type MultiSelectOption } from "@/components/MultiSelectList";
import { NewHookForm } from "@/components/companions/NewHookForm";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { hubCmd } from "@/lib/hubCmd";
import { parseCmdPayload } from "@/lib/hubWrite";
import { invalidateRegistry } from "@/lib/invalidate";
import { qk } from "@/lib/queryKeys";
import { useRegistry } from "@/hooks/useRegistry";
import { equipWithGate } from "@/hooks/useCompanionGate";
import { useCompanionPickerData } from "@/hooks/useCompanionPickerData";
import { useHookList } from "@/hooks/useHooks";
import {
	blockFromDraft,
	draftFromDeclared,
	isHookRef,
	reconcileSentence,
	removalConsequences,
	type CompanionsDraft,
	type CompanionsSetBlock,
	type CompanionsSetResult,
	type NewHookTaken,
	type ReconcileResult,
	type ShipsWith,
	type ShipsWithHook,
	type ShipsWithHookScaffold,
} from "@/lib/companions";
import { applySeed, seedAddedFrom, type CompanionSeed } from "@/lib/shipWith";
import type { RuleKind } from "@/types/permissions";

export interface CompanionsEditSheetProps {
	open: boolean;
	onClose: () => void;
	skillName: string;
	declared: ShipsWith;
	/** Wave 4c unit 3 (plans/3.md §3.3) — a "Ship this with a skill…" target
	 *  the sheet should stage as already selected on open. Applied on the
	 *  same open-transition effect as `declared`, but from the UNSEEDED
	 *  snapshot, so a seeded sheet is dirty from the moment it appears
	 *  (closing it asks the discard question). `undefined`/absent behaves
	 *  exactly as before this wave. */
	seed?: CompanionSeed;
}

const RULE_KIND_OPTIONS: { value: RuleKind; label: string }[] = [
	{ value: "deny", label: "Deny" },
	{ value: "ask", label: "Ask" },
	{ value: "allow", label: "Allow" },
];

/** The three permission-kind lists, in the same stable order the section
 *  renders rows in (declaredRows' `RULE_KIND_ORDER`). */
const RULE_KINDS: readonly RuleKind[] = ["deny", "ask", "allow"];

function ruleKey(kind: RuleKind, pattern: string): string {
	return `${kind}:${pattern}`;
}

/** Names present in `before` but not in `after` — the plain list diff every
 *  removal-consequence computation below shares. */
function dropped(before: string[], after: string[]): string[] {
	return before.filter((n) => !after.includes(n));
}

/** Wave 4c unit 3 (§3.3) — the seeded-note sentence's subject, one line per
 *  target kind. Presentation only; not exported. */
function seedSummary(seed: CompanionSeed): string {
	if (seed.kind === "hook") return `Hook "${seed.name}"`;
	if (seed.kind === "agent") return `Agent "${seed.name}"`;
	return `Rule "${seed.pattern}"`;
}

// ─── I7 reconcile toast (Approach 9/10, W12) ────────────────────────────────

export interface ReconcileToastInfo {
	title: string;
	body?: string;
	/** The first project with a pending companion — `null` when nothing is
	 *  pending anywhere, in which case the toast carries no action. */
	provisionProject: string | null;
}

/** Builds the save/sync toast's words from an I7 result: `reconcileSentence`
 *  supplies the leading pending/kept/error clause, and this appends the
 *  removed names (W12: "the toast … names removals"). Pure — no toast/gate
 *  call happens here, so a test can assert the words without mounting
 *  anything. */
export function reconcileToastInfo(result: ReconcileResult): ReconcileToastInfo {
	const entries = Object.entries(result.projects ?? {});
	const removedNames = [...new Set(entries.flatMap(([, r]) => r.stale_removed))];
	const pendingEntries = entries.filter(([, r]) => r.pending.length > 0);
	return {
		title: reconcileSentence(result),
		body: removedNames.length > 0 ? `Removed ${removedNames.join(", ")}` : undefined,
		provisionProject: pendingEntries.length > 0 ? pendingEntries[0][0] : null,
	};
}

/** Pushes the reconcile toast, wiring its `Provision` action (when there is
 *  one) through the SAME gate every other `Provision` affordance uses — no
 *  `force` (A22/C1): the consequence dialog is the consent. An already-open
 *  gate re-toasts instead of throwing past this handler, matching
 *  `ShipsWithSection`'s own `handleProvision`. */
export function pushReconcileToast(
	toast: ReturnType<typeof useToast>,
	skillName: string,
	result: ReconcileResult,
): void {
	const info = reconcileToastInfo(result);
	toast.push({
		kind: "info",
		title: info.title,
		body: info.body,
		action: info.provisionProject
			? {
					label: "Provision",
					onClick: () => {
						const project = info.provisionProject as string;
						void (async () => {
							try {
								await equipWithGate(skillName, project);
								toast.success(`Provisioned ${skillName} on ${project}`);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								if (message.includes("already open")) {
									toast.info("Another equip is open — finish it first.");
								} else {
									toast.error("Couldn't provision companions", message);
								}
							}
						})();
					},
				}
			: undefined,
	});
}

export function CompanionsEditSheet({
	open,
	onClose,
	skillName,
	declared,
	seed,
}: CompanionsEditSheetProps) {
	const { data: registry } = useRegistry();
	const queryClient = useQueryClient();
	const toast = useToast();
	const picker = useCompanionPickerData(declared);
	// Wave 4c unit 2 — the RAW hooks library (unfiltered by this skill's own
	// inline names, unlike `picker.hooks`): the new-hook form's §6.3a
	// `taken.library` needs every resolvable definition, including one this
	// skill doesn't currently reference at all.
	const hookListQuery = useHookList();

	const [draft, setDraft] = useState<CompanionsDraft>(() => draftFromDeclared(declared));
	// Agents newly toggled ON this session, by name -> the harness their
	// definition should be copied FROM (D9's `from`) — not part of the shared
	// `CompanionsDraft` shape (that stays a plain name list), so it lives here
	// and is folded into the I6 block only at Save.
	const [addedFrom, setAddedFrom] = useState<Record<string, string>>({});
	// A NEW inline hook added THIS session via `NewHookForm`, by name -> its
	// scaffold request (§3.1/§6.2) — the same side-map shape as `addedFrom`
	// above: `draft.hooks` stays a plain `ShipsWithHookEntry[]` and `scaffold`
	// is folded back in only at Save.
	const [hookScaffolds, setHookScaffolds] = useState<Record<string, ShipsWithHookScaffold>>({});
	const [newHookOpen, setNewHookOpen] = useState(false);
	const [rulePattern, setRulePattern] = useState("");
	const [ruleKind, setRuleKind] = useState<RuleKind>("deny");
	const [busy, setBusy] = useState(false);
	const [formError, setFormError] = useState<{ message: string; field?: string } | null>(null);
	const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

	// R17: re-seed the whole local form ONLY on the false→true `open`
	// transition, never merely because `declared` changed identity while the
	// sheet stays open. `declared` is `skill.ships_with` off the `["registry"]`
	// query — a fresh object on every refetch (background staleTime elapsing,
	// any `invalidateRegistry()` elsewhere in the app) — so keying the reseed
	// on `[open, declared]` silently wiped an in-progress deselect the moment
	// the registry happened to refetch. `openedRef` tracks the PREVIOUS
	// render's `open` so this only fires on an actual reopen.
	const openedRef = useRef(false);
	const seededSnapshotRef = useRef("");
	// Wave 4c unit 3 (§3.3) — the row a `seed` names, so the effect below can
	// tag it with `data-seeded`/`scrollIntoView` once it has painted.
	const agentsGroupRef = useRef<HTMLDivElement | null>(null);
	const hooksGroupRef = useRef<HTMLDivElement | null>(null);
	const rulesGroupRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (open && !openedRef.current) {
			const unseeded = draftFromDeclared(declared);
			// R6/§3.3: applied to the SEEDED copy only — `seededSnapshotRef` below
			// stays the UNSEEDED JSON, so a seeded sheet reads as dirty from the
			// moment it opens (closing it raises the discard question).
			const seededDraft = seed ? applySeed(unseeded, seed) : unseeded;
			setDraft(seededDraft);
			setAddedFrom(seed ? seedAddedFrom(seed) : {});
			setHookScaffolds({});
			setNewHookOpen(false);
			setRulePattern("");
			setRuleKind("deny");
			setFormError(null);
			seededSnapshotRef.current = JSON.stringify(unseeded);
		}
		openedRef.current = open;
		// Deliberately reacts to the open TRANSITION only (see comment above);
		// `declared`/`seed` are read at the moment of that transition, never a
		// re-seed trigger themselves.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const isDirty = JSON.stringify(draft) !== seededSnapshotRef.current;

	/** R17: closing (Cancel, Esc, backdrop) never silently drops staged edits —
	 *  a dirty draft asks first via `ConfirmDialog`; only a confirmed discard
	 *  or a clean draft actually closes. */
	function requestClose() {
		if (busy) return;
		if (isDirty) {
			setConfirmDiscardOpen(true);
			return;
		}
		onClose();
	}

	function confirmDiscard() {
		setConfirmDiscardOpen(false);
		onClose();
	}

	// ── Agents ──────────────────────────────────────────────────────────────

	const pickerAgentNames = new Set(picker.agents.map((a) => a.name));
	const agentOptions: MultiSelectOption[] = [
		...picker.agents.map((a) => ({
			id: a.name,
			glyph: <Icon name="agent" size={13} tone="mute" />,
			label: a.name,
			meta: (
				<span className="companions-edit-harnesses">
					{a.harnesses.map((h) => (
						<HarnessGlyph key={h} id={h} size={12} decorative />
					))}
				</span>
			),
			selected: draft.agents.includes(a.name),
			title: a.lossy
				? `Copied as tier worker, tools from ${a.sourceHarness} only`
				: a.description || undefined,
		})),
		// R1(a) — union the draft's OWN agent names in, the way `inlineHooksByName`
		// unions hooks below: `picker.agents` is USER-scope only, so a name
		// `draft.agents` carries that the picker never resolved (R1: a
		// project-scope seed — refused upstream since R1(b), but this stays as
		// defensive belt-and-braces for any other future path into
		// `draft.agents`) would otherwise have NO row anywhere to deselect it
		// from, and Save would still try to write it. Gated on `!picker.loading`
		// (R6's own COUNTS-not-`open` lesson, mirrored here): while the
		// claude/codex queries are still in flight `picker.agents` is
		// transiently empty too, and adding this row unconditionally would
		// render an instant, real-looking-but-wrong duplicate for every
		// already-declared agent before the real picker row ever arrives.
		...(picker.loading
			? []
			: draft.agents
					.filter((name) => !pickerAgentNames.has(name))
					.map((name) => ({
						id: name,
						glyph: <Icon name="agent" size={13} tone="mute" />,
						label: name,
						selected: true,
					}))),
	];

	function toggleAgent(name: string) {
		setDraft((d) => {
			if (d.agents.includes(name)) {
				return { ...d, agents: d.agents.filter((n) => n !== name) };
			}
			return { ...d, agents: [...d.agents, name] };
		});
		setAddedFrom((m) => {
			if (draft.agents.includes(name)) {
				// Deselecting — drop any pending "from" for this session's own add.
				if (!(name in m)) return m;
				const next = { ...m };
				delete next[name];
				return next;
			}
			const opt = picker.agents.find((a) => a.name === name);
			return opt ? { ...m, [name]: opt.sourceHarness } : m;
		});
	}

	// ── Hooks ───────────────────────────────────────────────────────────────
	// R18: the skill's OWN inline hooks are companions too — `picker.hooks`
	// (the library picker) deliberately excludes them (W13: offering one as a
	// `{ref}` would collide with its own inline entry under the same name),
	// which used to make them invisible AND unremovable in this sheet. They
	// get their own always-present rows, listed ABOVE the library options and
	// distinguished by an "inline" tag, so a declared inline hook can still be
	// deselected (removed) here even though it is never offered as a NEW
	// pick.

	/** The declared block's OWN inline hook definitions, by name — read once
	 *  from `declared` (never from the live `draft`), so re-selecting a
	 *  deselected inline hook restores its EXACT original definition instead
	 *  of inventing a `{ref}` to a name that was never a library entry. */
	const declaredInlineHooksByName = useMemo(() => {
		const map = new Map<string, ShipsWithHook>();
		for (const h of declared.hooks ?? []) {
			if (!isHookRef(h)) map.set(h.name, h);
		}
		return map;
	}, [declared]);

	/** Wave 4c unit 2 — the pre-existing declared inline hooks UNION whatever
	 *  inline hook the LIVE draft currently holds. Without the second half, a
	 *  brand-new hook `NewHookForm` just staged (never in `declared` — it did
	 *  not exist before this session) would have no row anywhere: it isn't a
	 *  declared inline hook, and it isn't in `picker.hooks` either (that list
	 *  is the pre-existing hooks LIBRARY, which a just-created hook is not
	 *  part of until Save). The draft's own copy wins on a name collision
	 *  (unreachable today — `_hook_name_taken`/`validateNewHook` already
	 *  refuse a new hook named after a declared one — kept defensive). */
	const inlineHooksByName = useMemo(() => {
		const map = new Map<string, ShipsWithHook>(declaredInlineHooksByName);
		for (const h of draft.hooks) {
			if (!isHookRef(h)) map.set(h.name, h);
		}
		return map;
	}, [declaredInlineHooksByName, draft.hooks]);

	const inlineHookOptions: MultiSelectOption[] = [...inlineHooksByName.values()].map((h) => ({
		id: h.name,
		glyph: <Icon name="hook" size={13} tone="mute" />,
		label: h.name,
		meta: (
			<span className="companions-edit-inline-meta">
				<Tag size="sm">inline</Tag>
				<span className="text-dim">{h.event}</span>
			</span>
		),
		selected: draft.hooks.some((dh) => dh.name === h.name),
		title: `${h.event} · ${h.command} — defined in this skill, not a library reference`,
	}));

	const hookOptions: MultiSelectOption[] = [
		...inlineHookOptions,
		...picker.hooks.map((h) => ({
			id: h.name,
			glyph: <Icon name="hook" size={13} tone="mute" />,
			label: h.name,
			meta: <span className="text-dim">{h.event}</span>,
			selected: draft.hooks.some((dh) => dh.name === h.name),
			title: `${h.event} · ${h.command}`,
		})),
	];

	// Wave 4c unit 3 (§3.3) — scrolls the seeded row/group into view once it
	// has painted. Keyed on the option COUNTS (not just `open`): on the very
	// first commit `useCompanionPickerData`'s queries have usually not
	// resolved yet, so `hookOptions`/`agentOptions` can still be empty — this
	// re-runs once they arrive, rather than only ever checking the empty
	// pre-load render (R6). Runs once per open, never re-fires on an
	// unrelated draft edit (unlike the data-seeded effect right below).
	useEffect(() => {
		if (!open || !seed) return;
		if (seed.kind === "hook") {
			const idx = hookOptions.findIndex((o) => o.id === seed.name);
			hooksGroupRef.current?.querySelectorAll('[role="option"]')[idx]?.scrollIntoView({
				block: "nearest",
			});
		} else if (seed.kind === "agent") {
			const idx = agentOptions.findIndex((o) => o.id === seed.name);
			agentsGroupRef.current?.querySelectorAll('[role="option"]')[idx]?.scrollIntoView({
				block: "nearest",
			});
		} else {
			rulesGroupRef.current?.scrollIntoView({ block: "nearest" });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, seed, hookOptions.length, agentOptions.length]);

	// R7 — `data-seeded` DERIVED from the CURRENT state every time it's
	// relevant, rather than written once by `querySelectorAll(...)[idx]` and
	// left to rot: every row in the group is cleared first, then the seed's
	// own row (matched by id, not a stale index) is re-marked ONLY while the
	// draft still carries it — so deselecting the seeded row clears the
	// marker instead of leaving it stuck forever (the bug this replaces).
	// `MultiSelectList`'s `MultiSelectOption` has no per-row passthrough for
	// an arbitrary data attribute (it is not in this wave's Allowed-files
	// list), so this still reaches the DOM directly rather than rendering the
	// attribute as a prop the way the RULES row below already does — but it
	// is now idempotent and self-clearing instead of a one-shot write.
	useEffect(() => {
		if (!open || !seed) return;
		if (seed.kind === "hook") {
			const rows = hooksGroupRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
			rows?.forEach((r) => delete r.dataset.seeded);
			const idx = hookOptions.findIndex((o) => o.id === seed.name);
			const row = idx >= 0 ? rows?.[idx] : undefined;
			if (row && draft.hooks.some((h) => h.name === seed.name)) row.dataset.seeded = "true";
		} else if (seed.kind === "agent") {
			const rows = agentsGroupRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
			rows?.forEach((r) => delete r.dataset.seeded);
			const idx = agentOptions.findIndex((o) => o.id === seed.name);
			const row = idx >= 0 ? rows?.[idx] : undefined;
			if (row && draft.agents.includes(seed.name)) row.dataset.seeded = "true";
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, seed, hookOptions.length, agentOptions.length, draft.hooks, draft.agents]);

	function toggleHook(name: string) {
		setDraft((d) => {
			const exists = d.hooks.some((h) => h.name === name);
			if (exists) return { ...d, hooks: d.hooks.filter((h) => h.name !== name) };
			// Restoring a previously-declared (or this-session-added) inline hook
			// brings back its EXACT definition; anything else is a library pick
			// (a `{ref}`).
			const inline = inlineHooksByName.get(name);
			return { ...d, hooks: [...d.hooks, inline ?? { ref: name, name }] };
		});
	}

	// ── New inline hook (wave 4c unit 2, §2.1/§3.1a/§6.3a) ──────────────────
	// §6.3a `HOOK_NAME_TAKEN`, read off the LIVE draft (the only "prior
	// declaration" this unsaved sheet has) rather than `declared`: a name
	// already staged as an inline hook or a ref THIS session must not be
	// offered again, on top of the full hooks-library collision the CLI
	// twin (`_hook_name_taken`) also refuses.
	const newHookTaken: NewHookTaken = useMemo(() => {
		const inline: string[] = [];
		const refs: string[] = [];
		for (const h of draft.hooks) {
			if (isHookRef(h)) refs.push(h.name);
			else inline.push(h.name);
		}
		const library = (hookListQuery.data?.hooks ?? []).map((h) => h.name);
		return { inline, refs, library };
	}, [draft.hooks, hookListQuery.data]);

	/** `NewHookForm`'s `onAdd` — stages the hook into the draft as an ordinary
	 *  inline entry and keeps its `scaffold` request in the side-map above,
	 *  folded back into the I6 body only at Save (mirrors `addedFrom`, D9). */
	function handleAddNewHook(hook: ShipsWithHook & { scaffold: ShipsWithHookScaffold }) {
		const { scaffold, ...rest } = hook;
		setDraft((d) => ({ ...d, hooks: [...d.hooks, rest] }));
		setHookScaffolds((m) => ({ ...m, [rest.name]: scaffold }));
		setNewHookOpen(false);
	}

	// ── Rules ───────────────────────────────────────────────────────────────

	function addRule() {
		const pattern = rulePattern.trim();
		if (!pattern) return;
		setDraft((d) => {
			if (d.permissions[ruleKind].includes(pattern)) return d;
			return {
				...d,
				permissions: { ...d.permissions, [ruleKind]: [...d.permissions[ruleKind], pattern] },
			};
		});
		setRulePattern("");
	}

	function removeRule(kind: RuleKind, pattern: string) {
		setDraft((d) => ({
			...d,
			permissions: { ...d.permissions, [kind]: d.permissions[kind].filter((p) => p !== pattern) },
		}));
	}

	// ── Removal consequences (W12) — read from the registry ledger BEFORE
	//    Save, one line per companion the draft is about to drop that some
	//    project's ledger still references. ─────────────────────────────────

	const consequences = useMemo(() => {
		const lines: { key: string; text: string; projects: string[] }[] = [];

		for (const name of dropped(declared.agents ?? [], draft.agents)) {
			const projects = removalConsequences(registry, "agent", name);
			if (projects.length > 0) {
				lines.push({
					key: `agent:${name}`,
					text: `Removing ${name} de-provisions it on ${projects.join(", ")}`,
					projects,
				});
			}
		}

		const declaredHookNames = (declared.hooks ?? []).map((h) => h.name);
		const draftHookNames = draft.hooks.map((h) => h.name);
		for (const name of dropped(declaredHookNames, draftHookNames)) {
			const projects = removalConsequences(registry, "hook", name);
			if (projects.length > 0) {
				lines.push({
					key: `hook:${name}`,
					text: `Removing ${name} de-provisions it on ${projects.join(", ")}`,
					projects,
				});
			}
		}

		for (const kind of RULE_KINDS) {
			for (const pattern of dropped(declared.permissions?.[kind] ?? [], draft.permissions[kind])) {
				const projects = removalConsequences(registry, "permission", { pattern, kind });
				if (projects.length > 0) {
					lines.push({
						key: `permission:${ruleKey(kind, pattern)}`,
						text: `Removing ${pattern} de-provisions it on ${projects.join(", ")}`,
						projects,
					});
				}
			}
		}

		return lines;
	}, [declared, draft, registry]);

	/** "Save · removes N on <project>" — the footer names what Save does
	 *  (Design-language conformance), never a bare number. More than one
	 *  affected project reads as a count instead of a name list. */
	const saveLabel = useMemo(() => {
		if (consequences.length === 0) return "Save";
		const projects = [...new Set(consequences.flatMap((c) => c.projects))];
		const where = projects.length === 1 ? projects[0] : `${projects.length} projects`;
		return `Save · removes ${consequences.length} on ${where}`;
	}, [consequences]);

	// ── Save (D10/I6, ONE call) ──────────────────────────────────────────────

	async function handleSave() {
		setBusy(true);
		setFormError(null);
		const block: CompanionsSetBlock = blockFromDraft(draft);
		block.agents = block.agents.map((a) =>
			addedFrom[a.name] ? { ...a, from: { harness: addedFrom[a.name] } } : a,
		);
		// Wave 4c unit 2 (§3.1/§6.2) — fold a NEW inline hook's scaffold request
		// back in; a `{ref}` entry is untouched.
		block.hooks = block.hooks.map((h) =>
			"ref" in h ? h : hookScaffolds[h.name] ? { ...h, scaffold: hookScaffolds[h.name] } : h,
		);
		const args = ["skill", "companions", "set", skillName, "--json-body", JSON.stringify(block)];
		try {
			// A15/S2: `hubCmd` (never `runHubCmd`) — an exit-1 `{ok:false,...}`
			// must reach this form, not become a thrown `HubCommandError`.
			const result = await hubCmd(args);
			const payload = parseCmdPayload<CompanionsSetResult>(result.output);
			if (!payload || !payload.ok) {
				const message =
					payload && !payload.ok
						? payload.error
						: result.output || "Couldn't save companions.";
				const field = payload && !payload.ok ? payload.field : undefined;
				setFormError({ message, field });
				setBusy(false);
				return;
			}
			// Grill #14 — `invalidateRegistry` already covers
			// `qk.skillCompanionsAll()` (the family-prefix stale this Save always
			// needed); `qk.hooks.list()` is added HERE, next to it, rather than
			// widening the pinned `REGISTRY_WRITE_KEYS` array
			// (`test/queryKeys.test.ts`) — the reverse flow's whole observable
			// outcome is a hook row's provenance changing on the Hooks screen.
			await invalidateRegistry(queryClient);
			await queryClient.invalidateQueries({ queryKey: qk.hooks.list() });
			// Grill #18 — the scaffold write is not fully reversible: a later
			// deselect + Save drops the DECLARATION, but the script stays on
			// disk (`_apply_set_body`'s `kept_files` rule, applied here too). Say
			// so up front, next to the created path.
			if (payload.scaffolded && payload.scaffolded.length > 0) {
				toast.success(
					payload.scaffolded.length === 1
						? "Created 1 script"
						: `Created ${payload.scaffolded.length} scripts`,
					`${payload.scaffolded.join(", ")} — stays on disk even if the hook is removed later.`,
				);
			}
			pushReconcileToast(toast, skillName, payload.reconcile);
			setBusy(false);
			onClose();
		} catch (err) {
			setFormError({ message: err instanceof Error ? err.message : String(err) });
			setBusy(false);
		}
	}

	return (
		<>
		<Sheet
			open={open}
			onClose={requestClose}
			title={`Edit companions · ${skillName}`}
			width={640}
			className="companions-edit-sheet"
			dismissable={!busy}
			footer={
				<>
					<Button variant="ghost" onClick={requestClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant="primary"
						busy={busy}
						onClick={() => void handleSave()}
						data-testid="companions-edit-save"
					>
						{saveLabel}
					</Button>
				</>
			}
		>
			{formError && (
				<p className="companions-edit-error" role="alert" data-testid="companions-edit-error">
					{formError.message}
					{formError.field ? ` (${formError.field})` : ""}
				</p>
			)}

			{seed && (
				<p className="companions-edit-seeded-note" data-testid="companions-edit-seeded">
					{seedSummary(seed)} is staged below — deselect it to leave it out of {skillName}.
				</p>
			)}

			<div className="companions-edit-group" ref={agentsGroupRef}>
				<div className="equip-group">
					<span className="equip-group-name">AGENTS</span>
					<span className="equip-group-count">{draft.agents.length}</span>
				</div>
				<MultiSelectList label="Agents" options={agentOptions} onToggle={toggleAgent} />
			</div>

			<div className="companions-edit-group" ref={hooksGroupRef}>
				<div className="equip-group">
					<span className="equip-group-name">HOOKS</span>
					<span className="equip-group-count">{draft.hooks.length}</span>
				</div>
				<MultiSelectList label="Hooks" options={hookOptions} onToggle={toggleHook} />
				{/* Rare-action disclosure (§2.1/grill #18): collapsed by default on
				    every open, and the LAST child of this group — under the picker
				    list, never above or inside the frequent toggle-existing-hooks
				    path. */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setNewHookOpen((v) => !v)}
					aria-expanded={newHookOpen}
					aria-controls="companions-edit-newhook"
					className="companions-edit-newhook-toggle"
					data-testid="companions-new-hook-toggle"
				>
					New hook…
				</Button>
				<div
					id="companions-edit-newhook"
					className="companions-edit-newhook"
					hidden={!newHookOpen}
				>
					<NewHookForm registry={registry} taken={newHookTaken} onAdd={handleAddNewHook} />
				</div>
			</div>

			<div className="companions-edit-group" ref={rulesGroupRef}>
				<div className="equip-group">
					<span className="equip-group-name">RULES</span>
					<span className="equip-group-count">
						{draft.permissions.allow.length +
							draft.permissions.deny.length +
							draft.permissions.ask.length}
					</span>
				</div>
				<div className="companions-edit-rule-list">
					{RULE_KINDS.flatMap((kind) =>
						draft.permissions[kind].map((pattern) => (
							<span
								key={ruleKey(kind, pattern)}
								className="companions-edit-rule"
								data-testid={`companions-edit-rule-${ruleKey(kind, pattern)}`}
								data-seeded={
									seed?.kind === "permission" && seed.ruleKind === kind && seed.pattern === pattern
										? "true"
										: undefined
								}
							>
								<Tag size="sm">{kind}</Tag>
								<span className="companions-edit-rule-pattern text-mono">{pattern}</span>
								<Button
									icon="x"
									size="sm"
									variant="ghost"
									aria-label={`Remove ${pattern}`}
									onClick={() => removeRule(kind, pattern)}
									data-testid={`companions-edit-rule-remove-${ruleKey(kind, pattern)}`}
								/>
							</span>
						)),
					)}
					{draft.permissions.allow.length +
						draft.permissions.deny.length +
						draft.permissions.ask.length ===
						0 && <span className="text-dim">No rules.</span>}
				</div>
				<div className="companions-edit-rule-add">
					<Field label="Pattern" className="companions-edit-rule-field">
						<input
							type="text"
							className="companions-edit-rule-input"
							value={rulePattern}
							onChange={(e) => setRulePattern(e.target.value)}
							placeholder="Bash(git push:*)"
							data-testid="companions-edit-rule-pattern"
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addRule();
								}
							}}
						/>
					</Field>
					<ChipRadios
						name="companions-edit-rule-kind"
						label="Kind"
						value={ruleKind}
						options={RULE_KIND_OPTIONS}
						onChange={setRuleKind}
					/>
					<Button
						variant="ghost"
						onClick={addRule}
						disabled={!rulePattern.trim()}
						data-testid="companions-edit-rule-add"
					>
						Add
					</Button>
				</div>
			</div>

			{consequences.length > 0 && (
				<div className="companions-edit-consequences" data-testid="companions-edit-consequences">
					{consequences.map((c) => (
						<p key={c.key} data-testid={`companions-edit-consequence-${c.key}`}>
							{c.text}
						</p>
					))}
				</div>
			)}
		</Sheet>
		<ConfirmDialog
			open={confirmDiscardOpen}
			onClose={() => setConfirmDiscardOpen(false)}
			onConfirm={confirmDiscard}
			title="Discard companion edits?"
			body="Closing now drops the changes staged in this sheet — nothing has been saved."
			confirmLabel="Discard"
			cancelLabel="Keep editing"
			tone="danger"
		/>
		</>
	);
}
