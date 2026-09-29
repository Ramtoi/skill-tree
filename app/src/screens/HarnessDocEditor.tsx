import { useFeedbackTab } from "@/hooks/useFeedbackTab";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { trackProcess } from "@/lib/trackProcess";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { PathText } from "@/components/PathText";
import { Plaque } from "@/components/Plaque";
import { StatusBadge } from "@/components/StatusBadge";
import { Toggle } from "@/components/Toggle";
import { ConfirmDialog } from "@/components/Modal";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	useGlobalDocStatus,
	docStatusFor,
	type GlobalDocStatusRow,
} from "@/hooks/useGlobalDocStatus";
import { useRegistry } from "@/hooks/useRegistry";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";
import { harnessDocBackTarget } from "@/lib/backTarget";
import { useUnsavedGuard } from "@/lib/navGuard";
import { useAppStore } from "@/store";
import { useToast } from "@/components/Toast";

/** `SidePanelSection` persistence-map key for this editor's REFERENCES
 *  section (F8 — one shared component, own storage per host). */
const HARNESS_DOC_SECTIONS_KEY = "st:harness-doc:sections";

interface GlobalDocReadResult {
	path: string;
	/** Where the read/write actually landed: `path` itself, or — for a
	 *  follower symlink — the harness it follows. Equal to `path` otherwise. */
	resolved_path: string;
	/** Whether `path` is a symlink (a follower doc). True even for a dangling
	 *  (broken) one. */
	is_link: boolean;
	exists: boolean;
	content: string;
	sha256: string | null;
}

interface GlobalDocWriteResult {
	sha256: string;
}

/** `hub harness doc link/unlink --json` payload — a fixed shape the app
 *  parses (see `global_docs.py`). Success carries no `error`; every failure
 *  does, and `"conflict"` is the one recoverable kind (retry with a
 *  decision) — every other `error` is shown as a plain toast. */
interface DocLinkPayload {
	follower?: string;
	source?: string;
	changed?: boolean;
	resolved_source?: string;
	backup?: string | null;
	bytes?: number;
	error?: string;
	harness?: string;
	existing_bytes?: number;
	preview?: string;
	followers?: string[];
	value?: string;
	detail?: string;
}

/** Basename of an absolute path (for the mono doc-name crumb). */
function basename(p: string): string {
	const parts = p.split(/[/\\]/);
	return parts[parts.length - 1] || p;
}

/** Human text for a doc-link/unlink error that is not the recoverable
 *  "conflict" (that one opens a confirm dialog instead of a toast). */
function describeDocError(p: DocLinkPayload): string {
	const who = harnessLabel(p.harness ?? "");
	switch (p.error) {
		case "has_followers": {
			const names = (p.followers ?? []).map((hid) => harnessLabel(hid));
			return `${who} shares its own file with ${names.join(", ")} — detach ${
				names.length === 1 ? "it" : "them"
			} there first.`;
		}
		case "external_link":
			return `${who}'s file links somewhere else — Skill Tree leaves it alone.`;
		case "source_missing":
			return `${who} has no instructions yet to share.`;
		case "source_not_a_file":
			return `${who}'s instructions are not a plain file, so nothing can follow them.`;
		case "same_harness":
			return "A harness can't follow its own file.";
		case "not_a_follower":
			return `${who} isn't following anything.`;
		case "unknown_harness":
			return `Unknown harness: ${p.harness ?? "?"}.`;
		case "invalid_on_conflict":
			return `Skill Tree asked for a decision the CLI doesn't know (${p.value ?? "?"}).`;
		case "io_error":
			return p.detail || "Couldn't reach the file.";
		default:
			// An error code this build doesn't know yet must still read as a
			// sentence — never a bare snake_case dump in a toast.
			return p.error
				? `Couldn't update the link (${p.error}).`
				: "Something went wrong.";
	}
}

async function runLink(
	follower: string,
	source: string,
	onConflict: "replace" | "merge" | null,
): Promise<DocLinkPayload> {
	const args = ["harness", "doc", "link", follower, "--to", source];
	if (onConflict) args.push("--on-conflict", onConflict);
	args.push("--json");
	const res = await hubCmd(args);
	return parseCliJson<DocLinkPayload>(res.output);
}

async function runUnlink(harnessId: string): Promise<DocLinkPayload> {
	const res = await hubCmd(["harness", "doc", "unlink", harnessId, "--json"]);
	return parseCliJson<DocLinkPayload>(res.output);
}

/** One SHARED WITH row's derived toggle state — computed once so the row
 *  render and its title/hint can never disagree. */
interface SharedRowView {
	checked: boolean;
	disabled: boolean;
	title?: string;
	hint: string;
}

function describeSharedRow(
	other: GlobalDocStatusRow,
	thisId: string,
	thisMissing: boolean,
	dirty: boolean,
): SharedRowView {
	const baseHint = hintForOtherState(other, thisId);
	if (dirty) {
		return {
			checked: other.state === "follows" && other.follows === thisId,
			disabled: true,
			title: "Save your edits first",
			hint: baseHint,
		};
	}
	if (thisMissing) {
		return {
			checked: false,
			disabled: true,
			title: "Save this file first",
			hint: baseHint,
		};
	}
	if (other.state === "follows") {
		if (other.follows === thisId) {
			return { checked: true, disabled: false, hint: baseHint };
		}
		const thirdLabel = harnessLabel(other.follows ?? "");
		return {
			checked: false,
			disabled: true,
			title: `Detach it from ${thirdLabel} first`,
			hint: baseHint,
		};
	}
	if (other.state === "external") {
		return {
			checked: false,
			disabled: true,
			title: "This file links elsewhere — Skill Tree leaves it alone",
			hint: baseHint,
		};
	}
	if (other.state === "source") {
		// Its own followers read ITS file. Linking it away would strand them,
		// so `global_docs.link` refuses with `has_followers` — say so before
		// the click instead of after it.
		return {
			checked: false,
			disabled: true,
			title: `Detach ${followerNames(other)} from it first`,
			hint: baseHint,
		};
	}
	return { checked: false, disabled: false, hint: baseHint };
}

/** "Codex" / "Codex and Pi" / "3 harnesses" — the followers of a row, in
 *  words. Naming one beats counting it. */
function followerNames(row: GlobalDocStatusRow): string {
	const names = row.followers.map((hid) => harnessLabel(hid));
	if (names.length === 0) return "its followers";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.length} harnesses`;
}

function hintForOtherState(other: GlobalDocStatusRow, thisId: string): string {
	switch (other.state) {
		case "follows":
			return other.follows === thisId
				? `follows ${harnessLabel(thisId)}`
				: `follows ${harnessLabel(other.follows ?? "")} · detach it there first`;
		case "external":
			return "linked elsewhere";
		case "broken":
			return "broken link";
		case "missing":
			return "not created";
		case "source":
			return `shared with ${followerNames(other)} · detach ${
				other.followers.length === 1 ? "it" : "them"
			} first`;
		default:
			return `own file · ${other.bytes ?? 0} chars`;
	}
}

/** The STATE kv row's text — mirrors `hub harness doc status`'s own words. */
function docStateLabel(
	docRow: GlobalDocStatusRow | undefined,
	exists: boolean,
): string {
	switch (docRow?.state) {
		case "follows":
			return `follows ${harnessLabel(docRow.follows ?? "")}`;
		case "source":
			// One follower is named; more than one is counted.
			return `source for ${followerNames(docRow)}`;
		case "broken":
			return "broken link";
		case "external":
			return "linked elsewhere";
		case "missing":
			return "not created";
		case "standalone":
			return "on disk";
		default:
			return exists ? "on disk" : "not created";
	}
}

/**
 * Editor for a harness's USER-GLOBAL instruction doc (`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, …). Composes `DocumentEditorShell`. The target path is
 * resolved server-side from the harness id — the frontend never names it. A
 * drift-on-disk write is refused and surfaces an overwrite confirm.
 *
 * A doc can also FOLLOW another harness's (global-doc-sharing, see
 * `docs/AGENT-DOCS.md`): the side panel then swaps its usual SHARED WITH
 * section for a "this is a link" plaque, or a "broken link" one when the
 * target vanished. `hub harness doc status` (`useGlobalDocStatus`) is the one
 * source of truth for which state applies.
 */
export function HarnessDocEditor() {
	const { id = "" } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const queryClient = useQueryClient();
	const harnesses = useHarnesses();
	const rescanHarnesses = useAppStore((s) => s.rescanHarnesses);
	const docStatusQuery = useGlobalDocStatus();
	const statusRows = docStatusQuery.data;
	const docRow = docStatusFor(statusRows, id);

	const [content, setContent] = useState("");
	const [original, setOriginal] = useState("");
	const [loadedSha, setLoadedSha] = useState<string | null>(null);
	const [loadedForPath, setLoadedForPath] = useState<string | null>(null);
	const [mode, setMode] = useState<DocMode>("edit");
  useFeedbackTab("harness-doc", mode);
	const [saving, setSaving] = useState(false);
	const [driftOpen, setDriftOpen] = useState(false);
	const [detaching, setDetaching] = useState(false);
	const [pendingShare, setPendingShare] = useState<Set<string>>(
		() => new Set(),
	);
	const [conflict, setConflict] = useState<{
		other: GlobalDocStatusRow;
		payload: DocLinkPayload;
	} | null>(null);
	const [conflictBusy, setConflictBusy] = useState(false);

	// The harness list drives the label + glyph. It may still be loading on a
	// direct deep-link; fall back to the identity registry for known ids.
	const status = harnesses.find((h) => h.id === id);
	const label = harnessLabel(id);
	const isKnownHarness = harnesses.length === 0 || status != null;

	const query = useQuery({
		queryKey: qk.globalDoc(id),
		queryFn: () => invoke<GlobalDocReadResult>("global_doc_read", { harnessId: id }),
		enabled: !!id && isKnownHarness,
	});
	const doc = query.data;

	// Seed the buffers once per loaded file (keyed by path so switching harnesses
	// re-seeds). Never clobber an in-flight edit of the same file.
	useEffect(() => {
		if (!doc) return;
		if (loadedForPath === doc.path) return;
		setLoadedForPath(doc.path);
		setContent(doc.content);
		setOriginal(doc.content);
		setLoadedSha(doc.sha256);
		setMode("edit");
	}, [doc, loadedForPath]);

	// Computed early (not after the loading/not-found guards below) because
	// `useRegistry`, `useSkillRefs` and `useUnsavedGuard` are hooks and must
	// run unconditionally on every render — they cannot follow a conditional
	// `return`.
	const dirty = content !== original;
	const { data: registry } = useRegistry();
	// `back` is a fresh literal every render on purpose — the hook memoizes on
	// its VALUES, never its identity (see `useSkillRefs`'s own doc comment).
	const refsHost = { back: harnessDocBackTarget(id, label) };
	const refs = useSkillRefs({ host: refsHost, content, registry });
	const leaveGuard = useUnsavedGuard(dirty);

	// Unknown harness id → honest dead-end with a way back (mirrors HarnessConfig).
	if (id && harnesses.length > 0 && !status) {
		return (
			<>
				<ScreenHeader
					back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
					title={label}
					crumbs={["harnesses", id]}
				/>
				<EmptyState
					icon="doc"
					title="No such harness"
					description={`Skill Tree doesn't know a harness with id "${id}", so it has no global instruction file to edit.`}
				/>
			</>
		);
	}

	if (query.isError) {
		return (
			<>
				<ScreenHeader
					back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
					title={label}
					crumbs={["harnesses", id]}
					subline="Couldn't reach the instruction file"
				/>
				<EmptyState
					icon="warning"
					title="Couldn't load the instruction file"
					description={String(query.error)}
				/>
			</>
		);
	}

	// C4 — the read is still in flight. Returning `null` handed the router a
	// blank main column; the chrome is known from the route, so it paints now.
	if (!doc) {
		return (
			<>
				<ScreenHeader
					back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
					title={label}
					crumbs={["harnesses", id]}
					subline="User-global instructions this harness reads for every session"
				/>
				<EmptyState
					icon="doc"
					title="Loading instructions"
					description="Reading the file from disk…"
				/>
			</>
		);
	}

	// `docRow` (the live filesystem scan) is authoritative once loaded — it is
	// the only thing that can tell "missing" apart from a "broken" follower
	// link (both read back as `exists: false, content: ""` from the plain doc
	// read). Before it loads, fall back to the old heuristic.
	const missing = docRow
		? docRow.state === "missing"
		: !doc.exists && original === "";
	const broken = docRow?.state === "broken";
	const follows = docRow?.state === "follows" ? docRow.follows : null;
	// SHARED WITH renders by default (including while status is still
	// loading) and hides only once we KNOW this doc is a follower, broken, or
	// an unmanaged external link.
	// A failed status scan must not be rendered as a wall of
	// "not created" rows — that is a lie about every other harness, and
	// a toggle built on it would link against unknown state.
	const statusFailed = docStatusQuery.isError;
	const showSharedWith =
		docRow?.state !== "follows" &&
		docRow?.state !== "broken" &&
		docRow?.state !== "external";
	const otherHarnesses = harnesses.filter(
		(h) => h.id !== id && !!h.global_doc && h.installed,
	);
	const lineCount = content === "" ? 0 : content.split("\n").length;
	const bytes = new TextEncoder().encode(content).length;
	const fileName = basename(doc.path);
	// The file the bytes actually live in. For a follower that is the SOURCE's
	// own doc (`~/.claude/CLAUDE.md`), NOT this harness's link (`AGENTS.md`) —
	// the plaque copy names it, so it must never read back this doc's name.
	// Status row first (it is the scan's own answer), the Rust read's resolved
	// path as the fallback while status is still loading.
	const sourceFileName = basename(
		(follows ? docStatusFor(statusRows, follows)?.path : null) ||
			doc.resolved_path ||
			doc.path,
	);

	/** Stale-cache guard: a link/unlink rewrites the OTHER harness's doc (it
	 *  becomes a link to this one, or gets its own copy back), so that
	 *  harness's `qk.globalDoc(<id>)` entry is now wrong. Without this the
	 *  editor for it — opened inside the 30s default `staleTime` — seeds its
	 *  buffers from the pre-link bytes and the first save trips the drift
	 *  confirm. */
	async function invalidateDocStatus(...alsoDocs: string[]) {
		await queryClient.invalidateQueries({ queryKey: qk.globalDocStatus() });
		for (const hid of alsoDocs) {
			await queryClient.invalidateQueries({ queryKey: qk.globalDoc(hid) });
		}
	}

	async function reloadDoc() {
		const fresh = await query.refetch();
		if (fresh.data) {
			setContent(fresh.data.content);
			setOriginal(fresh.data.content);
			setLoadedSha(fresh.data.sha256);
			setLoadedForPath(fresh.data.path);
		}
		return fresh.data;
	}

	async function write(expected: string | null) {
		setSaving(true);
		try {
			const res = await invoke<GlobalDocWriteResult>("global_doc_write", {
				harnessId: id,
				content,
				expectedSha256: expected,
			});
			setOriginal(content);
			setLoadedSha(res.sha256);
			toast.success(
				`Saved ${fileName}`,
				`${label} · user-global instructions`,
			);
			await queryClient.invalidateQueries({ queryKey: qk.globalDoc(id) });
			// A save through a follower link changes the SOURCE's own byte
			// count, which other cards' "own file · N chars" hints read.
			await invalidateDocStatus();
			// The Harnesses card renders a missing hint off harness_list (Zustand
			// store) — rescan so a first-save flips the file to "exists".
			await rescanHarnesses();
		} catch (err) {
			const msg = String(err);
			if (expected !== null && /drift/i.test(msg)) {
				setDriftOpen(true);
			} else {
				toast.error(`Couldn't save ${fileName}`, msg);
			}
		} finally {
			setSaving(false);
		}
	}

	async function reloadFromDisk() {
		setDriftOpen(false);
		const fresh = await reloadDoc();
		if (fresh) {
			toast.push({
				kind: "info",
				title: `Reloaded ${fileName}`,
				body: "Discarded your unsaved edits for the on-disk version.",
			});
		}
	}

	/** Detach THIS doc from what it follows (the follower plaque's Detach
	 *  button, and the broken plaque's "Start a fresh file"). */
	async function detachSelf() {
		setDetaching(true);
		try {
			const payload = await trackProcess(
				{
					title: `Detaching ${label}`,
					body: fileName,
					kind: "fs",
					target: `global-doc:${id}`,
				},
				() => runUnlink(id),
				{ failWhen: (p) => (p.error ? describeDocError(p) : null) },
			);
			if (payload.error) return;
			// This doc's own entry is re-seeded by `reloadDoc` below; the
			// source it left keeps its bytes but not its follower count.
			await invalidateDocStatus(...(follows ? [follows] : []));
			await reloadDoc();
			toast.push({
				kind: "info",
				title: `Detached — ${fileName} is its own file now`,
			});
		} catch {
			/* the process card already carries the failure */
		} finally {
			setDetaching(false);
		}
	}

	async function afterLinkSuccess(other: GlobalDocStatusRow) {
		// `other`'s doc is a link to this one now — its cached content, its
		// `is_link` and its `resolved_path` all just changed.
		await invalidateDocStatus(other.harness);
		toast.push({ kind: "info", title: `${other.label} now reads ${fileName}` });
	}

	/** SHARED WITH toggle ON — link `other` to follow THIS doc. A real file
	 *  on the other side comes back as an exit-2 conflict, which opens the
	 *  confirm dialog instead of failing outright. */
	async function shareWith(other: GlobalDocStatusRow) {
		setPendingShare((s) => new Set(s).add(other.harness));
		try {
			const payload = await trackProcess(
				{
					title: `Sharing with ${other.label}`,
					body: fileName,
					kind: "fs",
					target: `global-doc:${other.harness}`,
				},
				() => runLink(other.harness, id, null),
				{
					successBody: (p) =>
						p.error === "conflict"
							? "Needs a decision"
							: `${other.label} now reads ${fileName}`,
					failWhen: (p) =>
						p.error && p.error !== "conflict" ? describeDocError(p) : null,
				},
			);
			if (payload.error === "conflict") {
				setConflict({ other, payload });
				return;
			}
			if (payload.error) return;
			await afterLinkSuccess(other);
		} catch {
			/* the process card already carries the failure */
		} finally {
			setPendingShare((s) => {
				const next = new Set(s);
				next.delete(other.harness);
				return next;
			});
		}
	}

	/** SHARED WITH toggle OFF — detach `other`, leaving it its own real copy. */
	async function unshareWith(other: GlobalDocStatusRow) {
		setPendingShare((s) => new Set(s).add(other.harness));
		try {
			const payload = await trackProcess(
				{
					title: `Detaching ${other.label}`,
					body: fileName,
					kind: "fs",
					target: `global-doc:${other.harness}`,
				},
				() => runUnlink(other.harness),
				{ failWhen: (p) => (p.error ? describeDocError(p) : null) },
			);
			if (payload.error) return;
			await invalidateDocStatus(other.harness);
			toast.push({
				kind: "info",
				title: `${other.label} keeps a copy of its own`,
			});
		} catch {
			/* the process card already carries the failure */
		} finally {
			setPendingShare((s) => {
				const next = new Set(s);
				next.delete(other.harness);
				return next;
			});
		}
	}

	/** The conflict confirm's two verbs: replace the other file outright, or
	 *  fold its text into THIS one first. A merge rewrites this doc's own
	 *  bytes on disk, so the editor buffers get re-seeded from a fresh read. */
	async function resolveConflict(decision: "replace" | "merge") {
		if (!conflict) return;
		const { other } = conflict;
		setConflictBusy(true);
		try {
			const payload = await trackProcess(
				{
					title:
						decision === "merge"
							? `Merging ${other.label}'s text`
							: `Replacing ${other.label}'s file`,
					body: fileName,
					kind: "fs",
					target: `global-doc:${other.harness}`,
				},
				() => runLink(other.harness, id, decision),
				{ failWhen: (p) => (p.error ? describeDocError(p) : null) },
			);
			if (payload.error) return;
			setConflict(null);
			await afterLinkSuccess(other);
			if (decision === "merge") await reloadDoc();
		} catch {
			/* the process card already carries the failure */
		} finally {
			setConflictBusy(false);
		}
	}

	return (
		<>
			<ScreenHeader
				back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
				title={label}
				crumbs={[
					<span key="doc" className="text-mono">
						{fileName}
					</span>,
				]}
				subline={
					follows
						? `Linked to ${harnessLabel(follows)}'s instructions · edits save to the shared file`
						: "User-global instructions this harness reads for every session"
				}
			/>

			<DocumentEditorShell
				content={content}
				onContentChange={setContent}
				mode={mode}
				onModeChange={setMode}
				diffOriginal={original}
				dirty={dirty}
				saving={saving}
				onSave={() => void write(loadedSha)}
				extraExtensions={refs.extension}
				skillRefs={refs.render}
				splitStorageKey="st:layout:harness-doc"
				headerExtras={
					<span className="harness-doc-title">
						<HarnessGlyph id={id} label={label} size={14} decorative />
						<span className="text-mono">{fileName}</span>
					</span>
				}
				footerExtras={
					<>
						<span>
							<Icon name="doc" size={10} /> global instructions
						</span>
						<span>
							{lineCount} line{lineCount === 1 ? "" : "s"} · {bytes} chars
						</span>
					</>
				}
				sidePanel={
					<>
						{follows && (
							<Plaque
								eyebrow={`Follows ${harnessLabel(follows)}`}
								accent="anchor"
								role="status"
								actions={
									<>
										<Button
											variant="ghost"
											size="sm"
											icon="arrow-right"
											onClick={() => navigate(`/harness/${follows}/doc`)}
										>
											Open {harnessLabel(follows)}'s instructions
										</Button>
										<Button
											variant="ghost"
											size="sm"
											busy={detaching}
											onClick={() => void detachSelf()}
										>
											Detach
										</Button>
									</>
								}
							>
								<p className="source-banner-copy">
									This file is a link. Edits here save to{" "}
									{harnessLabel(follows)}'s{" "}
									<span className="text-mono">{sourceFileName}</span>.
								</p>
							</Plaque>
						)}

						{broken && (
							<Plaque eyebrow="Broken link" accent="amber" role="status">
								<p className="source-banner-copy">
									{docRow?.follows
										? `It pointed at ${harnessLabel(docRow.follows)}'s instructions, which no longer exist.`
										: "It pointed at instructions that no longer exist."}
								</p>
								<div className="source-banner-actions">
									<Button
										variant="ghost"
										size="sm"
										busy={detaching}
										onClick={() => void detachSelf()}
									>
										Start a fresh file
									</Button>
								</div>
							</Plaque>
						)}

						{missing && (
							<Plaque eyebrow="Not created yet" accent="anchor" role="status">
								<p className="source-banner-copy">Saving creates it at this path.</p>
							</Plaque>
						)}

						<div className="side-panel-block">
							<dl className="kv">
								<div className="kv-row">
									<dt>path</dt>
									<dd>
										<PathText className="kv-static" data-wrap path={doc.path} />
									</dd>
								</div>
								{!missing && (
									<div className="kv-row">
										<dt>state</dt>
										<dd>
											<StatusBadge
												channel={broken ? "warn" : doc.exists ? "ok" : "warn"}
												shape="dot"
											/>
											{docStateLabel(docRow, doc.exists)}
										</dd>
									</div>
								)}
							</dl>
						</div>

						{registry && (
							<SkillRefsSection
								host={refsHost}
								content={content}
								registry={registry}
								storageKey={HARNESS_DOC_SECTIONS_KEY}
							/>
						)}

						{showSharedWith && (
							<div className="side-panel-block">
								<h4>Shared with</h4>
								<p className="shared-with-subtitle">
									Harnesses that read this same text.
									{dirty && " · save first"}
								</p>
								{statusFailed ? (
									<p className="shared-with-empty">
										Couldn't read who shares this file. Run{" "}
										<span className="text-mono">hub harness doc status</span> to see
										why.
									</p>
								) : otherHarnesses.length === 0 ? (
									<p className="shared-with-empty">
										No other installed harness reads a global file.
									</p>
								) : (
									<div className="shared-with-list">
										{otherHarnesses.map((h) => {
											const other: GlobalDocStatusRow =
												docStatusFor(statusRows, h.id) ?? {
													harness: h.id,
													label: h.label,
													path: h.global_doc ?? "",
													state: "missing",
													follows: null,
													followers: [],
													bytes: null,
												};
											const view = describeSharedRow(other, id, missing, dirty);
											const busy = pendingShare.has(h.id);
											return (
												<div className="shared-with-row" key={h.id}>
													<HarnessGlyph
														id={h.id}
														label={other.label}
														size={16}
														decorative
													/>
													<div className="shared-with-row-text">
														<span className="shared-with-row-label">
															{other.label}
														</span>
														<span className="shared-with-row-hint text-mono text-dim">
															{view.hint}
														</span>
													</div>
													<span title={view.title}>
														<Toggle
															variant="switch"
															size="sm"
															checked={view.checked}
															disabled={view.disabled || busy}
															ariaLabel={`Share ${fileName} with ${other.label}`}
															onChange={(next) => {
																if (next) void shareWith(other);
																else void unshareWith(other);
															}}
														/>
													</span>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}
					</>
				}
			/>

			{/* Raised by the navigation guard for ANY in-app exit while the buffer
			    is dirty — the rail, a NavPanel row, the palette, a `g …` chord,
			    the back arrow, or a References row click. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Leave without saving?"
				body={`${fileName} has unsaved changes. Leaving discards them.`}
				cancelLabel="Stay"
				confirmLabel="Leave"
			/>

			<ConfirmDialog
				open={driftOpen}
				onClose={() => setDriftOpen(false)}
				onConfirm={() => {
					setDriftOpen(false);
					void write(null);
				}}
				title={`${fileName} changed on disk`}
				tone="danger"
				confirmLabel="Overwrite"
				confirmIcon="save"
				body={
					<>
						The file changed on disk since you loaded it. Overwrite it with your
						edits, or reload the on-disk version and discard your changes.
					</>
				}
				blastRadius={
					<Button
						variant="ghost"
						size="sm"
						icon="refresh"
						onClick={() => void reloadFromDisk()}
					>
						Reload from disk (discard my edits)
					</Button>
				}
			/>

			<ConfirmDialog
				open={!!conflict}
				onClose={() => setConflict(null)}
				onConfirm={() => void resolveConflict("replace")}
				title={
					conflict
						? `${conflict.other.label} has its own ${basename(conflict.other.path)}`
						: ""
				}
				tone="danger"
				busy={conflictBusy}
				confirmLabel="Replace with link"
				confirmIcon="link"
				body={
					conflict && (
						<>
							It holds {conflict.payload.existing_bytes ?? 0} chars of its own
							instructions. Skill Tree backs it up to{" "}
							<span className="text-mono">
								_hub-backups/global-docs/{conflict.other.harness}/
							</span>{" "}
							before linking.
						</>
					)
				}
				blastRadius={
					conflict && (
						<>
							<pre className="doc-conflict-preview text-mono">
								{(conflict.payload.preview ?? "").split("\n").slice(0, 12).join("\n")}
							</pre>
							<div className="doc-conflict-merge">
								<Button
									variant="soft"
									size="sm"
									icon="plus"
									busy={conflictBusy}
									onClick={() => void resolveConflict("merge")}
								>
									Append its text here, then link
								</Button>
							</div>
						</>
					)
				}
			/>
		</>
	);
}
