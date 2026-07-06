import { useState } from "react";
import { invoke } from "@/lib/ipc";

import { LoadingButton } from "@/components/loading/LoadingButton";
import { Spinner } from "@/components/loading/Spinner";
import {
	CodeAreaDiff,
	CodeAreaEdit,
	CodeAreaPreview,
} from "@/components/CodeArea";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import type { RemoteDiffAction } from "@/types";
import { DriftBadge, resolveActionKey } from "./DriftBadge";

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
	docs: RemoteDiffAction[];
	busy: boolean;
	/** In-flight action key from the parent (so the Pull button — which routes
	 *  through the parent's runHub — spins for the right doc only). */
	pending?: string | null;
	onResolve: (
		name: string,
		op: "push" | "pull" | "keep-local" | "keep-remote",
	) => void;
	/** Refetch the remote plan after a push (drift status changes). */
	onChanged?: () => void;
}

const BYTES_PER_KB = 1024;

/** Human byte size for the "full file" reassurance line. */
function formatBytes(byteCount: number): string {
	if (byteCount < BYTES_PER_KB) return `${byteCount} B`;
	return `${(byteCount / BYTES_PER_KB).toFixed(1)} KB`;
}

/** Agent-docs round-trip editor (SOUL / MEMORY / USER). Lists the remote's
 *  doc artifacts with drift status, fetches the REAL remote content into the
 *  Edit/Preview/Diff CodeArea on open, and pushes the edited doc back through
 *  the connector's diff gate (atomic, backup-on-change, drift-refused). Pull
 *  still adopts the box version into the hub via the resolve op. */
export function RemoteDocEditor({ remoteId, docs, busy, pending, onResolve, onChanged }: Props) {
	const toast = useToast();
	const [open, setOpen] = useState<string | null>(null);
	const [mode, setMode] = useState<DocMode>("edit");
	const [draft, setDraft] = useState("");
	const [original, setOriginal] = useState("");
	const [loading, setLoading] = useState(false);
	const [pushing, setPushing] = useState(false);
	// Only true after a successful fetch — so the "full file" line never shows on
	// a failed read (where `original` would misleadingly read as 0 B).
	const [fetchOk, setFetchOk] = useState(false);

	async function openDoc(name: string) {
		if (open === name) {
			setOpen(null);
			return;
		}
		setOpen(name);
		setMode("edit");
		setDraft("");
		setOriginal("");
		setFetchOk(false);
		setLoading(true);
		try {
			const res = await invoke<FetchDocResult>("remote_fetch_doc", {
				id: remoteId,
				doc: name,
			});
			if (res.ok && res.content !== undefined) {
				setDraft(res.content);
				setOriginal(res.content);
				setFetchOk(true);
			} else {
				toast.error(`Could not load ${name}`, res.detail ?? "fetch failed");
			}
		} catch (e) {
			toast.error(`Could not load ${name}`, String(e));
		} finally {
			setLoading(false);
		}
	}

	async function pushDoc(name: string, force: boolean) {
		setPushing(true);
		try {
			const res = await invoke<PushDocResult>("remote_push_doc", {
				id: remoteId,
				doc: name,
				content: draft,
				force,
			});
			toast.success(`Pushed ${name}`, res.detail ?? undefined);
			setOriginal(draft);
			onChanged?.();
		} catch (e) {
			const msg = String(e);
			if (!force && /drift/i.test(msg)) {
				toast.push({
					kind: "info",
					title: `${name} drifted on the box`,
					body: "The remote copy changed since you fetched it. Pull to review, or push with force to overwrite.",
				});
			} else {
				toast.error(`Could not push ${name}`, msg);
			}
		} finally {
			setPushing(false);
		}
	}

	if (docs.length === 0) {
		return (
			<EmptyState
				icon="doc"
				title="No agent docs on the box"
				description="SOUL.md, MEMORY.md, and USER.md appear here when they exist on the box. Fetch to read, edit, then push them through the connector's diff gate (backup-on-change, drift-refused)."
			/>
		);
	}

	const active = docs.find((d) => d.name === open) ?? null;
	const dirty = draft !== original;
	const blocked = busy || pushing || loading;
	// "Full file" reassurance: the connector reads the WHOLE remote file (cat, no
	// truncation), so a small curated doc (e.g. Hermes caps MEMORY.md at ~2 KB) is
	// complete, not clipped. Show the fetched size so that reads as intentional.
	const loaded = active != null && !loading && fetchOk;
	const bytes = new TextEncoder().encode(original).length;
	const lineCount = original === "" ? 0 : original.split("\n").length;
	const pullPending =
		active != null &&
		pending === resolveActionKey("agent_doc", active.name, "pull");

	return (
		<div className="remote-doc-editor">
			<div className="remote-doc-list">
				{docs.map((d) => (
					<button
						key={d.name}
						type="button"
						className="remote-doc-tab"
						data-active={open === d.name || undefined}
						onClick={() => openDoc(d.name)}
					>
						<Icon name="doc" size={13} />
						<span className="text-mono">{d.name}</span>
						<DriftBadge status={d.drift} />
					</button>
				))}
			</div>

			{active && (
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
							variant="ghost"
							size="sm"
							icon="fetch"
							loading={pullPending}
							loadingLabel="Pulling…"
							disabled={blocked}
							title="Adopt the box's version into the hub"
							onClick={() => onResolve(active.name, "pull")}
						>
							Pull
						</LoadingButton>
						<LoadingButton
							variant="primary"
							size="sm"
							icon="equip"
							loading={pushing}
							loadingLabel="Pushing…"
							disabled={blocked || !dirty}
							title="Push the edited doc to the box (diff gate + backup-on-change)"
							onClick={() => pushDoc(active.name, false)}
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
			)}
		</div>
	);
}
