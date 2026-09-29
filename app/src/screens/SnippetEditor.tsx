import { useFeedbackTab } from "@/hooks/useFeedbackTab";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { trackProcess } from "@/lib/trackProcess";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { InlineName } from "@/components/InlineName";
import { Plaque } from "@/components/Plaque";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SidePanelSection } from "@/components/SidePanelSection";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { ApplyToDialog } from "@/components/snippets/ApplyToDialog";
import {
	AppliedLocationsPanel,
	type RefreshScope,
} from "@/components/snippets/AppliedLocationsPanel";
import { ConfirmDialog } from "@/components/Modal";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";
import { SnippetCreateForm } from "@/components/snippets/SnippetCreateForm";
import { TagInput } from "@/components/snippets/TagInput";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { useRegistry } from "@/hooks/useRegistry";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { errText, parseCmdPayload } from "@/lib/hubWrite";
import { runHubCmd } from "@/lib/hubCmd";
import { snippetBackTarget } from "@/lib/backTarget";
import { useUnsavedGuard } from "@/lib/navGuard";
import { qk } from "@/lib/queryKeys";
import { usageRollup } from "@/lib/snippetUsage";
import {
	applySnippet,
	deleteSnippet,
	editSnippet,
	updateSnippetEverywhere,
	useInvalidateSnippets,
	useSnippet,
	useSnippetNames,
	useSnippetScan,
} from "@/hooks/useSnippets";
import type {
	SnippetEditResult,
	SnippetLocation,
	SnippetUpdateEverywhereResult,
	SnippetUsage,
} from "@/types/snippets";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shared disclosure map key for every collapsible block in this panel. */
const SNIPPET_EDITOR_SECTIONS_KEY = "st:snippet-editor:sections";

/** `hub snippet rename <old> <new> --json` payload — parsed via the shared
 *  `parseCmdPayload` (never a bare `JSON.parse`: hub output can carry
 *  trailing chatter after the payload). The CLI exits 0 even when `errors`
 *  is non-empty — the rename itself landed; a location it could not
 *  rewrite keeps its old marker id and reads as orphaned. */
interface SnippetRenameResult {
	action: "rename";
	from: string;
	to: string;
	renamed: Array<{ project: string; rel: string }>;
	errors: Array<{ project: string; rel: string; error: string }>;
	skipped?: Array<{ project: string; rel: string; reason: string }>;
}

/** The toast for a rename that landed but couldn't rewrite every applied
 *  location — a tuple so a call site can spread it straight into
 *  `toast.error(...)`. */
function renamePartialFailureToast(errorCount: number): [string, string] {
	return [
		`Renamed, but ${errorCount} ${errorCount === 1 ? "location" : "locations"} couldn't be rewritten`,
		"those blocks keep the old id and now read as orphaned",
	];
}

function normalizeBody(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

/** The one save-consequence line the amber plaque shows: what a save is
 *  about to rewrite, and — since a section summary is a static rollup, not a
 *  save-time fact — the hand-edited call-out that only applies right now. */
function saveConsequenceCopy(refreshCount: number, modifiedCount: number): string {
	const modifiedNote =
		modifiedCount > 0
			? ` ${modifiedCount} hand-edited ${modifiedCount === 1 ? "block is" : "blocks are"} kept as ${
					modifiedCount === 1 ? "it is" : "they are"
				}.`
			: "";
	if (refreshCount > 0) {
		return `Bumps the version and refreshes ${refreshCount} ${refreshCount === 1 ? "block" : "blocks"}.${modifiedNote}`;
	}
	return `Bumps the version.${modifiedNote}`;
}

/**
 * `/snippet/:name` — one snippet's whole screen. `name === "new"` is create
 * mode. The route replaced a 360px master list + search + tag filter: the
 * NavPanel's Context group already enumerates every snippet, so this screen
 * leans purely into the content of ONE.
 */
export function SnippetEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const isNew = routeName === "new";
	return isNew ? <SnippetCreateForm /> : <SnippetDetail name={routeName ?? ""} />;
}

// ─── Detail (edit an existing snippet) ──────────────────────────────────────
// Standalone navigation uses the snippet list in the navigator. When opened
// from Agent Docs, ScreenHeader supplies the referrer-aware return arrow and
// restores the selected document through the existing navigation guard.
function SnippetDetail({ name }: { name: string }) {
	const navigate = useNavigate();
	const toast = useToast();
	const invalidate = useInvalidateSnippets();
	const undoableAction = useUndoableAction();

	// Fetch the snippet directly and let its error mean "not found" — gating
	// on the list first serialised two IPC round-trips and let a stale list
	// (a just-deleted name) send the screen down the wrong branch.
	// Names-only: `lib` here is only ever used for allTags + picking the next
	// snippet on delete, neither of which needs the usage scan.
	const { data: lib = [] } = useSnippetNames();
	const { data: snippet, error } = useSnippet(name);
	// Applied locations come from ONE shared walk (`snippet status --name`),
	// not from `show` — the body/header can paint long before this resolves.
	const scan = useSnippetScan({ name });
	const scanning = scan.isPending;

	const [desc, setDesc] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [body, setBody] = useState("");
	const [loadedFor, setLoadedFor] = useState<string | null>(null);
	/** The name a just-committed rename staged `loadedFor` for, until the
	 *  route's own `name` param (deferred behind React Router's `startTransition`)
	 *  catches up — see the load effect below for why this exists. */
	const pendingRenameRef = useRef<string | null>(null);
	/** The route `name` as of the LATEST render — a ref (not the `name` prop
	 *  itself) so a closure created long ago (the undo toast can sit for up
	 *  to 7s) can still ask "is the editor showing that snippet RIGHT NOW?"
	 *  instead of trusting whatever was true when the closure was made. */
	const nameRef = useRef(name);
	nameRef.current = name;
	const [mode, setMode] = useState<DocMode>("edit");
  useFeedbackTab("snippet", mode);
	const [applyOpen, setApplyOpen] = useState(false);
	/** The "Apply to…" dialog's own write is in flight — the dialog stays up and
	 *  busy so a failure lands beside the project + file that caused it. */
	const [applying, setApplying] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	/** Which half of a "Save & update" process is in flight, for the Save
	 *  button's `savingLabel`. `null` while idle. */
	const [savePhase, setSavePhase] = useState<"save" | "refresh" | null>(null);
	/** Shared between Save's own refresh phase and the panel's own "Update
	 *  everywhere" — only one of those refreshes can ever be running at once. */
	/** Which refresh is in flight, if any: Save's own second phase (`"save"`,
	 *  rewrites applied + outdated) or the panel's "Update everywhere"
	 *  (`"outdated"`, rewrites outdated only). One owner sets AND clears it —
	 *  a `finally` never touches a refresh the other path started. */
	const [refreshScope, setRefreshScope] = useState<RefreshScope | null>(null);
	const refreshing = refreshScope !== null;
	/** What `save()` / `refreshEverywhere()` read at CALL time. A process
	 *  card's Retry fires from a closure captured at click time; reading through
	 *  this ref means a retry writes the buffer as it is NOW, and its guards see
	 *  the flags as they are now. Assigned once per render below the guards. */
	const latest = useRef<{
		desc: string;
		tags: string[];
		body: string;
		dirty: boolean;
		saveRefreshes: boolean;
		refreshTargets: SnippetLocation[];
		outdatedCount: number;
		saving: boolean;
		refreshing: boolean;
	} | null>(null);
	// The description well grows with its text and scrolls past the
	// stylesheet's cap (`.side-identity textarea`). Called unconditionally —
	// before the not-found/loading guards below — so the hook order never
	// shifts; `ref.current` is simply null while a guard branch renders.
	const descRef = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(descRef, desc);

	// Initialize buffers when the snippet (or a fresh copy of it) loads.
	// A rename's `navigate()` notifies subscribers of the route change via
	// React Router's own deferred scheduling (see `useLibraryListState.ts` for
	// the same race with `setSearchParams`), so BOTH the route `name` prop AND
	// `snippet.name` (derived from a query keyed on it) can still read the OLD
	// value for a render or two after a rename's synchronous `setLoadedFor`
	// already landed — a render where `name` merely HASN'T CAUGHT UP YET is
	// indistinguishable, on its own, from "the user navigated away". This
	// effect is the ONLY place that decides "moved away": it fires exactly
	// when `name` ACTUALLY TRANSITIONS (compared to the last value it saw),
	// never merely because `name` currently differs from what's staged.
	// Declared BEFORE the load effect below so it runs first in the same
	// commit (React flushes effects in declaration order) — the load effect
	// always sees an up-to-date `pendingRenameRef`.
	const prevNameRef = useRef(name);
	useEffect(() => {
		if (prevNameRef.current === name) return;
		prevNameRef.current = name;
		if (pendingRenameRef.current && pendingRenameRef.current !== name) {
			// The route just moved to somewhere OTHER than what a rename
			// staged — abandon the stale stage so a load for whatever is on
			// screen now is never suppressed by a stamp meant elsewhere.
			pendingRenameRef.current = null;
		}
	}, [name]);

	// Initialize buffers when the snippet (or a fresh copy of it) loads.
	useEffect(() => {
		if (!snippet) return;
		// While a rename is staged and this fetch doesn't answer for that name
		// yet, wait — it's either the OLD name's stale fetch resolving in the
		// same window, or the NEW name's fetch still in flight. Whether the
		// stage should be ABANDONED is decided above (on a genuine `name`
		// transition), never here — `snippet.name` alone lags exactly like
		// `name` does and would reintroduce the very race that split exists to
		// avoid.
		if (pendingRenameRef.current && snippet.name !== pendingRenameRef.current) return;
		if (pendingRenameRef.current === snippet.name) pendingRenameRef.current = null;
		const stamp = `${snippet.name}@v${snippet.version}:${snippet.hash}`;
		if (loadedFor === stamp) return;
		setLoadedFor(stamp);
		setDesc(snippet.description);
		setTags(snippet.tags);
		setBody(snippet.body ?? "");
		setMode("edit");
	}, [snippet, loadedFor]);

	const locations = scan.data?.locations ?? [];
	const allTags = useMemo(
		() => [...new Set(lib.flatMap((s) => s.tags))].sort(),
		[lib],
	);

	// Computed here — not below, alongside `usage`/`bodyChanged` — because
	// `useSkillRefs` and the leave guard are hooks and must run unconditionally
	// on every render, before the not-found/loading guards below return early.
	// Optional-chained so it reads `false` while `snippet` hasn't loaded yet.
	// `!!snippet &&` matters, not just tidiness: while `snippet` is loading —
	// on first mount, but ALSO mid-rename, when the route's `name` has moved
	// on but this fetch hasn't answered for it yet — the local buffers still
	// hold whatever was loaded for the PREVIOUS name (the load effect above
	// only resets them once THIS name's data arrives). Comparing that leftover
	// state against an empty/undefined snippet would read as dirty and arm the
	// leave guard against a navigation nobody asked to be questioned.
	const dirty =
		!!snippet &&
		(body !== (snippet.body ?? "") ||
			desc !== snippet.description ||
			tags.join(",") !== snippet.tags.join(","));
	const { data: registry } = useRegistry();
	const refs = useSkillRefs({
		host: { back: snippetBackTarget(name) },
		content: body,
		registry,
	});
	const leaveGuard = useUnsavedGuard(dirty);

	// ─── Guards ───────────────────────────────────────────────────────────────
	// C4: not-found and loading share the same header box the loaded screen
	// below renders — a dead or slow deep link still tells you where you are.
	const guardHeader = (
		<ScreenHeader icon="snippet" nameMono={name} crumbs={["snippets", name]} />
	);
	if (error) {
		return (
			<>
				{guardHeader}
				<div className="main-body">
					<EmptyState
						icon="warning"
						title="Snippet not found"
						description={`No snippet named ${name}`}
						action={
							<BackButton onClick={() => navigate("/snippets")}>Back to snippets</BackButton>
						}
					/>
				</div>
			</>
		);
	}

	if (!snippet) {
		return (
			<>
				{guardHeader}
				<div className="main-body">
					<EmptyState
						icon="search"
						title="Loading snippet"
						description="Reading the library…"
					/>
				</div>
			</>
		);
	}

	// Computed from the scan's locations, not `snippet.usage` — `show` no
	// longer carries usage (see `useSnippet`). While `scanning` this is
	// `{count: 0, summary: "none", ...}` (no locations yet); the header masks
	// that behind a skeleton pill instead of flashing a false "unused".
	const usage: SnippetUsage = usageRollup(locations);
	const bodyChanged = normalizeBody(body) !== normalizeBody(snippet.body ?? "");
	// What `snippet update --all` would rewrite vs. skip if Save ran it now.
	const refreshTargets = locations.filter(
		(l) => l.status === "applied" || l.status === "outdated",
	);
	const modifiedCount = locations.filter((l) => l.status === "modified").length;
	const outdatedCount = locations.filter((l) => l.status === "outdated").length;
	// Save becomes "Save & update N" only once the scan has actually run — a
	// pending scan reports zero locations, which would otherwise flash a plain
	// "Save" before the real count is known.
	const saveRefreshes = bodyChanged && !scanning && refreshTargets.length > 0;
	latest.current = {
		desc,
		tags,
		body,
		dirty,
		saveRefreshes,
		refreshTargets,
		outdatedCount,
		saving,
		refreshing,
	};

	type SaveResult = { edit: SnippetEditResult; refresh: SnippetUpdateEverywhereResult | null };
	function saveSuccessText(r: SaveResult): string {
		if (r.refresh) {
			return `v${r.edit.version} · refreshed ${r.refresh.refreshed.length}${
				r.refresh.skipped.length ? ` · ${r.refresh.skipped.length} modified skipped` : ""
			}`;
		}
		if (!r.edit.body_changed) return "metadata updated";
		return r.edit.outdated_locations
			? `v${r.edit.version} · ${r.edit.outdated_locations} applied ${r.edit.outdated_locations === 1 ? "location is" : "locations are"} now outdated`
			: `bumped to v${r.edit.version}`;
	}

	async function save() {
		const L = latest.current;
		if (!L || !snippet || !L.dirty || L.saving || L.refreshing) return;
		setSaving(true);
		setSavePhase("save");
		const n = L.refreshTargets.length;
		const doRefresh = L.saveRefreshes;
		let editSucceeded = false;
		let startedRefresh = false;
		try {
			const res = await trackProcess<SaveResult>(
				{
					title: `Saving ${snippet.name}`,
					body: doRefresh
						? `writing library · then ${n} applied ${n === 1 ? "location" : "locations"}`
						: "writing library",
					kind: "fs",
					target: `snippet:${snippet.name}`,
					steps: doRefresh ? 2 : null,
				},
				async (ctl) => {
					const edit = await editSnippet({
						name: snippet.name,
						description: L.desc,
						tags: L.tags,
						body: L.body,
					});
					editSucceeded = true;
					if (!doRefresh) return { edit, refresh: null };
					ctl.update({
						step: 1,
						body: `v${edit.version} saved · refreshing ${n} ${n === 1 ? "location" : "locations"}…`,
					});
					setSavePhase("refresh");
					startedRefresh = true;
					setRefreshScope("save");
					const refresh = await updateSnippetEverywhere({ name: snippet.name });
					return { edit, refresh };
				},
				{
					successBody: saveSuccessText,
					// After a successful edit, retrying means re-running the refresh
					// alone — re-running `save()` would write the (unchanged) library
					// a second time for no reason.
					retry: () => void (editSucceeded ? refreshEverywhere() : save()),
				},
			);
			toast.success(`Saved ${snippet.name}`, saveSuccessText(res));
			invalidate();
		} catch (err) {
			toast.error(
				editSucceeded ? "Saved, but couldn't refresh locations" : "Couldn't save snippet",
				String(err),
			);
			// The edit itself landed even though the refresh failed — invalidate
			// so the header/version and the rows' outdated status stop lying.
			if (editSucceeded) invalidate();
		} finally {
			setSaving(false);
			setSavePhase(null);
			// Only clear the refresh this save started — a metadata-only save that
			// overlapped nothing must not drop the panel's rows out of "updating".
			if (startedRefresh) setRefreshScope(null);
		}
	}

	async function refreshEverywhere() {
		const L = latest.current;
		if (!L || !snippet || L.saving || L.refreshing) return;
		const n0 = L.outdatedCount;
		setRefreshScope("outdated");
		try {
			const res = await trackProcess(
				{
					title: `Updating ${snippet.name}`,
					body: `refreshing ${n0} outdated ${n0 === 1 ? "location" : "locations"}`,
					kind: "fs",
					target: `snippet:${snippet.name}`,
				},
				() => updateSnippetEverywhere({ name: snippet.name }),
				{
					successBody: (r) =>
						`refreshed ${r.refreshed.length}${r.skipped.length ? ` · ${r.skipped.length} modified skipped` : ""}`,
					retry: () => void refreshEverywhere(),
				},
			);
			const n = res.refreshed.length;
			toast[n ? "success" : "info"](
				`Updated ${n} ${n === 1 ? "location" : "locations"}`,
				res.skipped.length
					? `${res.skipped.length} modified ${res.skipped.length === 1 ? "block" : "blocks"} skipped — update those by hand`
					: "all outdated blocks refreshed",
			);
			invalidate();
		} catch (err) {
			toast.error("Couldn't update everywhere", String(err));
		} finally {
			setRefreshScope(null);
		}
	}

	async function confirmDelete() {
		if (!snippet) return;
		try {
			await deleteSnippet({ name: snippet.name, force: locations.length > 0 });
			toast.error(
				`Deleted ${snippet.name}`,
				locations.length
					? `${locations.length} in-file ${locations.length === 1 ? "block remains" : "blocks remain"} — now orphaned`
					: "removed from library",
			);
			setDeleteOpen(false);
			invalidate();
			// Pick the next snippet from the list we already hold. `/snippets`
			// would redirect off the cached list, which still names the one just
			// deleted, and dead-end on "not found".
			const next = lib
				.map((s) => s.name)
				.filter((n) => n !== snippet.name)
				.sort((a, b) => a.localeCompare(b))[0];
			// The snippet is gone — there is nothing left to save, so this
			// navigation must not be questioned by the leave guard (F3).
			leaveGuard.bypass(() =>
				navigate(next ? `/snippet/${encodeURIComponent(next)}` : "/snippets", {
					replace: true,
				}),
			);
		} catch (err) {
			toast.error("Couldn't delete snippet", String(err));
		}
	}

	async function applyTo(project: string, rel: string) {
		if (!snippet || applying) return;
		setApplying(true);
		try {
			const res = await trackProcess(
				{
					title: `Applying ${snippet.name}`,
					body: `${project} · ${rel}`,
					kind: "fs",
					target: `snippet:${snippet.name}`,
				},
				() =>
					applySnippet({
						name: snippet.name,
						project,
						relativePath: rel,
					}),
				{ successBody: "block written" },
			);
			setApplyOpen(false);
			toast.success(
				`Applied ${snippet.name}`,
				res.mirrored?.length
					? `${project} · ${rel} + ${res.mirrored.map((m) => m.rel).join(", ")} (mirrored)`
					: `${project} · ${rel}`,
			);
			invalidate();
		} catch (err) {
			toast.error("Couldn't apply snippet", String(err));
		} finally {
			setApplying(false);
		}
	}

	function validateRename(next: string): string | null {
		if (!snippet) return null;
		if (!NAME_RE.test(next)) {
			return "Use lowercase kebab-case (letters, digits, single hyphens).";
		}
		if (lib.some((s) => s.name === next && s.name !== snippet.name)) {
			return `A snippet named "${next}" already exists.`;
		}
		return null;
	}

	// A snippet's name is the marker id, so a rename rewrites every applied
	// block's marker too (`hub snippet rename`) — same reversible-edit shape as
	// a bundle rename: an undo toast, not a confirm dialog. The CLI exits 0
	// even when it could not rewrite every applied location (`errors` in the
	// payload) — `--json` + a warning toast is how that partial failure gets
	// surfaced instead of reading as a plain, unqualified success.
	async function renameSnippet(next: string) {
		if (!snippet) return;
		if (saving || refreshing) {
			toast.info("Can't rename right now", "Wait for the current save to finish.");
			// Throw (not a plain return) — InlineName's `commit()` only restores
			// on success; a resolved promise here would close the field and
			// silently discard the draft the user just typed.
			throw new Error("Rename blocked while a save is in progress.");
		}
		const previous = snippet.name;
		let renameErrorCount = 0;
		try {
			await undoableAction({
				do: async () => {
					const res = await runHubCmd(["snippet", "rename", previous, next, "--json"]);
					renameErrorCount = parseCmdPayload<SnippetRenameResult>(res.output)?.errors?.length ?? 0;
					// Version/hash are untouched by a rename — pre-stage the load
					// effect's stamp under the name it will see once `useSnippet`
					// refetches at the new route, so a dirty desc/tags/body buffer
					// reads as already loaded instead of being reset from disk.
					// `pendingRenameRef` covers the tick where `navigate()` hasn't
					// landed yet but a stale fetch for the OLD name still resolves.
					pendingRenameRef.current = next;
					setLoadedFor(`${next}@v${snippet.version}:${snippet.hash}`);
					// The rename PRESERVES every buffer (see the pre-stage above) —
					// nothing is lost, so the leave guard must not fire (F3).
					leaveGuard.bypass(() =>
						navigate(`/snippet/${encodeURIComponent(next)}`, { replace: true }),
					);
				},
				undo: async () => {
					const L = latest.current;
					if (L?.saving || L?.refreshing) {
						toast.info("Can't undo right now", "Wait for the current save to finish.");
						throw new Error("Undo blocked while a save is in progress.");
					}
					const res = await runHubCmd(["snippet", "rename", next, previous, "--json"]);
					const undoErrorCount = parseCmdPayload<SnippetRenameResult>(res.output)?.errors?.length ?? 0;
					// Only pre-stage when the editor is STILL showing the snippet
					// being undone — `nameRef` reads the route as of RIGHT NOW, not
					// as of when this closure was created (the undo toast can sit
					// for up to 7s). If the user navigated elsewhere in the
					// meantime, the local buffers belong to THAT snippet, not to
					// `previous` — pre-staging would silently adopt that content as
					// `previous`'s own on the next save. Always still navigate back,
					// so undo lands on the restored snippet either way — with a
					// fresh disk load there when the stamp wasn't staged.
					if (nameRef.current === next) {
						pendingRenameRef.current = previous;
						setLoadedFor(`${previous}@v${snippet.version}:${snippet.hash}`);
					}
					// Same reasoning as the rename's own navigation above — the undo
					// preserves whatever is in the buffer, so no leave-guard prompt (F3).
					leaveGuard.bypass(() =>
						navigate(`/snippet/${encodeURIComponent(previous)}`, { replace: true }),
					);
					if (undoErrorCount > 0) {
						toast.error(...renamePartialFailureToast(undoErrorCount));
					}
				},
				label: `Renamed ${previous} to ${next}`,
				invalidate: [
					qk.snippets.listAll(),
					qk.snippets.oneAll(),
					qk.snippets.scanAll(),
					qk.agentDocs.all(),
					qk.searchCorpus(),
				],
			});
			if (renameErrorCount > 0) {
				toast.error(...renamePartialFailureToast(renameErrorCount));
			}
		} catch (err) {
			toast.error("Couldn't rename snippet", errText(err));
			// InlineName keeps the field open with the draft on a rethrow.
			throw err;
		}
	}

	return (
		<>
			<ScreenHeader
				icon="snippet"
				nameMono={
					<InlineName
						value={snippet.name}
						label="Snippet name"
						validate={validateRename}
						onSave={renameSnippet}
					/>
				}
				meta={
					<>
						{/* The version tag needs no scan — it renders immediately. */}
						<Tag size="sm">v{snippet.version}</Tag>
						{scanning ? (
							<span className="lds-skel snip-usage-skel" aria-label="Scanning projects" />
						) : usage.count > 0 ? (
							<>
								<Tag size="sm" color="var(--green)">
									{usage.count} applied
								</Tag>
								{usage.outdated_count > 0 && (
									<Tag size="sm">{usage.outdated_count} outdated</Tag>
								)}
							</>
						) : (
							<Tag size="sm">unused</Tag>
						)}
					</>
				}
				crumbs={["snippets", snippet.name]}
				primary={
					<Button variant="primary" icon="plus" onClick={() => setApplyOpen(true)}>
						Apply to…
					</Button>
				}
				overflow={[
					{ icon: "plus", label: "New snippet", onClick: () => navigate("/snippet/new") },
				]}
			/>

			<DocumentEditorShell
				content={body}
				onContentChange={setBody}
				mode={mode}
				onModeChange={setMode}
				diffOriginal={snippet.body ?? ""}
				dirty={dirty}
				extraExtensions={refs.extension}
				skillRefs={refs.render}
				onSave={save}
				saving={saving}
				saveDisabled={saving || refreshing}
				saveLabel={saveRefreshes ? `Save & update ${refreshTargets.length}` : "Save"}
				savingLabel={
					savePhase === "refresh" ? `Updating ${refreshTargets.length}…` : "Saving…"
				}
				splitStorageKey="st:layout:snippets"
				footerExtras={
					<>
						<span>
							<Icon name="doc" size={10} /> markdown snippet
						</span>
						<span>
							{body.split("\n").length} lines · {body.length} chars
						</span>
						<span className="editor-foot-spacer" />
						<span>updated {snippet.updated || "—"}</span>
					</>
				}
				sidePanel={
					<>
						{/* Identity is durable: the description is the field authors
						    iterate on with the body; tags are text until clicked. The
						    name lives in the screen header and renames in place there
						    (`hub snippet rename`), which rewrites the marker id in
						    every applied block — the name is never edited here. */}
						<div className="side-panel-block side-identity" data-block="identity">
							<Field label="description" full>
								<textarea
									ref={descRef}
									value={desc}
									onChange={(e) => setDesc(e.target.value)}
									placeholder="One line — what this snippet instructs"
								/>
							</Field>
							<dl className="kv">
								<div className="kv-row">
									<dt>tags</dt>
									<dd>
										<TagInput tags={tags} onChange={setTags} suggestions={allTags} compact />
									</dd>
								</div>
							</dl>
						</div>

						{/* Directly under the identity block, above AppliedLocationsPanel
						    — the fan-out warning below has to be read before the fan-out
						    list. Absent (registry still loading, or nothing mentioned). */}
						{registry && (
							<SkillRefsSection
								host={{ back: snippetBackTarget(name) }}
								content={body}
								registry={registry}
								storageKey={SNIPPET_EDITOR_SECTIONS_KEY}
							/>
						)}

						{/* Hidden while the save runs — the process card carries that
						    message. One line, not two: a consequence of the click about
						    to happen, not idle information a section head could hold. */}
						{bodyChanged && !scanning && !saving && locations.length > 0 && (
							<Plaque eyebrow="On save" accent="amber" role="status">
								<p className="source-banner-copy">
									{saveConsequenceCopy(refreshTargets.length, modifiedCount)}
								</p>
							</Plaque>
						)}

						<AppliedLocationsPanel
							name={snippet.name}
							version={snippet.version}
							locations={locations}
							scanning={scanning}
							refreshing={refreshScope}
							locked={saving}
							onApplyOpen={() => setApplyOpen(true)}
							onUpdateEverywhere={refreshEverywhere}
							onMutated={invalidate}
							storageKey={SNIPPET_EDITOR_SECTIONS_KEY}
						/>

						<SidePanelSection
							id="marker"
							title="Marker format"
							summary="hub-owned comments"
							defaultOpen={false}
							storageKey={SNIPPET_EDITOR_SECTIONS_KEY}
						>
							<div className="snip-marker-hint">
								Applying wraps the body in hub-owned comments. Never hand-author
								these.
								<pre className="snip-marker-pre">
									<code>{`<!-- skill-tree:snippet\n  id=${snippet.name} v=${snippet.version} sha=${snippet.hash} -->\n…body…\n<!-- skill-tree:snippet:end\n  id=${snippet.name} -->`}</code>
								</pre>
							</div>
						</SidePanelSection>
					</>
				}
				dangerZone={
					<div className="danger-zone">
						<h4>Danger zone</h4>
						<div className="snip-danger-note">
							{scanning
								? "Checking where this snippet is applied…"
								: locations.length
									? `Deleting removes it from the library only. ${locations.length} applied ${locations.length === 1 ? "block stays" : "blocks stay"} in place and will read as orphaned.`
									: "Deleting removes this snippet from the library. It isn’t applied anywhere, so nothing else changes."}
						</div>
						<div className="actions">
							<Button
								variant="danger"
								icon="trash"
								disabled={scanning}
								disabledReason="Wait for the scan — deleting needs to know how many blocks it orphans."
								onClick={() => setDeleteOpen(true)}
							>
								Delete snippet
							</Button>
						</div>
					</div>
				}
			/>

			{applyOpen && (
				<ApplyToDialog
					snippetName={snippet.name}
					locations={locations}
					onClose={() => setApplyOpen(false)}
					onApply={applyTo}
					busy={applying}
				/>
			)}

			{deleteOpen && (
				<ConfirmDialog
					open
					title={`Delete ${snippet.name}?`}
					confirmLabel={
						locations.length
							? `Delete · leave ${locations.length} orphaned`
							: "Delete snippet"
					}
					tone="danger"
					confirmIcon="trash"
					onClose={() => setDeleteOpen(false)}
					onConfirm={confirmDelete}
					body={
						<>
							{locations.length ? (
								<>
									<p>
										<span className="text-mono">{snippet.name}</span> is still applied
										to {locations.length}{" "}
										{locations.length === 1 ? "file" : "files"}. Deleting leaves those
										blocks in place — they&rsquo;ll read as <strong>orphaned</strong>{" "}
										(removable, no update).
									</p>
									<div className="snip-delete-files">
										{locations.map((l, i) => (
											<div key={i} className="snip-delete-file" title={`${l.project} — ${l.rel}`}>
												<span className="snip-delete-file-project">{l.project}</span>
												<span className="text-mono text-dim snip-delete-file-path">{l.rel}</span>
											</div>
										))}
									</div>
								</>
							) : (
								<p>
									This removes <span className="text-mono">{snippet.name}</span> from
									the library. It isn&rsquo;t applied anywhere.
								</p>
							)}
						</>
					}
				/>
			)}

			{/* Raised by the navigation guard for ANY in-app exit the guard was
			    not explicitly bypassed for — the rail, a NavPanel row, the
			    palette, a `g …` chord, a ref ⌘-click. The three navigations this
			    screen owns itself (delete, rename, rename-undo) bypass it (F3)
			    because none of them actually lose the buffer. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Leave without saving?"
				body={`${snippet.name} has unsaved changes. Leaving discards them.`}
				confirmLabel="Leave"
				cancelLabel="Stay"
				tone="danger"
			/>
		</>
	);
}
