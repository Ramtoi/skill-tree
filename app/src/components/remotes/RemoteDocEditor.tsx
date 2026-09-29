import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";

import { LoadingButton } from "@/components/loading/LoadingButton";
import { Spinner } from "@/components/loading/Spinner";
import {
	CodeAreaDiff,
	CodeAreaEdit,
	CodeAreaPreview,
} from "@/components/CodeArea";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";

type DocMode = "edit" | "preview" | "diff";

interface FetchDocResult {
	doc: string;
	ok: boolean;
	content?: string;
	sha256?: string;
	detail?: string;
}

interface PushDocResult {
	ok?: boolean;
	detail?: string;
}

interface Props {
	remoteId: string;
	/** The doc this pane edits — one pane per doc, mounted only while its
	 *  row's disclosure is open (`RemoteDetail.docRow`'s `detail` slot). */
	docName: string;
	busy: boolean;
	/** Refetch the remote plan after a push (drift status changes). */
	onChanged?: () => void;
}

const BYTES_PER_KB = 1024;

/** Human byte size for the "full file" reassurance line. */
function formatBytes(byteCount: number): string {
	if (byteCount < BYTES_PER_KB) return `${byteCount} B`;
	return `${(byteCount / BYTES_PER_KB).toFixed(1)} KB`;
}

/** Agent-doc round-trip editor (SOUL / MEMORY / USER) for ONE doc — fetches
 *  the REAL remote content on mount into the Edit/Preview/Diff CodeArea, and
 *  pushes the edited draft back through the connector's diff gate (atomic,
 *  backup-on-change, drift-refused). Pull / Keep local / Keep remote live one
 *  level up as the doc row's own `RemoteResolveActions` (REVIEW-B #2) — this
 *  pane owns only the fetch → edit → push round-trip, so there is exactly one
 *  place for the Pull decision, not two. */
export function RemoteDocEditor({ remoteId, docName, busy, onChanged }: Props) {
	const toast = useToast();
	const [mode, setMode] = useState<DocMode>("edit");
	const [draft, setDraft] = useState("");
	const [original, setOriginal] = useState("");
	const [loading, setLoading] = useState(true);
	const [pushing, setPushing] = useState(false);
	// Only true after a successful fetch — so the "full file" line never shows on
	// a failed read (where `original` would misleadingly read as 0 B).
	const [fetchOk, setFetchOk] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setFetchOk(false);
		setDraft("");
		setOriginal("");
		(async () => {
			try {
				const res = await invoke<FetchDocResult>("remote_fetch_doc", {
					id: remoteId,
					doc: docName,
				});
				if (cancelled) return;
				if (res.ok && res.content !== undefined) {
					setDraft(res.content);
					setOriginal(res.content);
					setFetchOk(true);
				} else {
					toast.error(`Couldn't load ${docName}`, res.detail ?? "fetch failed");
				}
			} catch (e) {
				if (!cancelled) toast.error(`Couldn't load ${docName}`, String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
		// Fetch once per mount — identity is (remoteId, docName); `toast` is a
		// stable ref from context.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [remoteId, docName]);

	async function pushDoc(force: boolean) {
		setPushing(true);
		try {
			const res = await invoke<PushDocResult>("remote_push_doc", {
				id: remoteId,
				doc: docName,
				content: draft,
				force,
			});
			toast.success(`Pushed ${docName}`, res.detail ?? undefined);
			setOriginal(draft);
			onChanged?.();
		} catch (e) {
			const msg = String(e);
			if (!force && /drift/i.test(msg)) {
				toast.push({
					kind: "info",
					title: `${docName} drifted on the box`,
					body: "The remote copy changed since you fetched it. Pull to review, or push with force to overwrite.",
				});
			} else {
				toast.error(`Couldn't push ${docName}`, msg);
			}
		} finally {
			setPushing(false);
		}
	}

	const dirty = draft !== original;
	const blocked = busy || pushing || loading;
	// "Full file" reassurance: the connector reads the WHOLE remote file (cat, no
	// truncation), so a small curated doc (e.g. Hermes caps MEMORY.md at ~2 KB) is
	// complete, not clipped. Show the fetched size so that reads as intentional.
	const loaded = !loading && fetchOk;
	const bytes = new TextEncoder().encode(original).length;
	const lineCount = original === "" ? 0 : original.split("\n").length;

	return (
		<div className="remote-doc-pane">
			<div className="remote-doc-pane-head">
				<div className="chips" role="tablist">
					{(["edit", "preview", "diff"] as DocMode[]).map((m) => (
						<button
							key={m}
							type="button"
							className="chip"
							role="tab"
							aria-pressed={mode === m}
							onClick={() => setMode(m)}
						>
							{m}
						</button>
					))}
				</div>
				<span className="spacer" />
				<LoadingButton
					variant="primary"
					size="sm"
					icon="equip"
					loading={pushing}
					loadingLabel="Pushing…"
					disabled={blocked || !dirty}
					title="Push the edited doc to the box (diff gate + backup-on-change)"
					onClick={() => void pushDoc(false)}
				>
					Push
				</LoadingButton>
			</div>

			<div className="remote-doc-note">
				{loading ? <Spinner size={11} /> : <Icon name="warning" size={11} />}
				<span>
					{loading
						? "Loading the box's current content…"
						: "Editing the live remote doc. Push writes atomically with backup-on-change; a doc that drifted on the box is refused unless you force it — never auto-clobbered."}
				</span>
				{loaded && (
					<span className="remote-doc-size text-mono text-dim" title="The connector reads the entire remote file — nothing is truncated. Small files (e.g. a curated, char-limited memory) are complete as shown.">
						· full file · {formatBytes(bytes)} · {lineCount} line
						{lineCount === 1 ? "" : "s"}
					</span>
				)}
			</div>

			<div className="remote-doc-body">
				{mode === "edit" && (
					<CodeAreaEdit content={draft} onChange={setDraft} />
				)}
				{mode === "preview" && <CodeAreaPreview content={draft} />}
				{mode === "diff" && (
					<CodeAreaDiff original={original} current={draft} />
				)}
			</div>
		</div>
	);
}
