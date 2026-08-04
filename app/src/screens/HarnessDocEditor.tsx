import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { Field, MetaGrid } from "@/components/Field";
import { InfoBanner } from "@/components/InfoBanner";
import { ConfirmDialog } from "@/components/Modal";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useAppStore } from "@/store";
import { useToast } from "@/components/Toast";

interface GlobalDocReadResult {
	path: string;
	exists: boolean;
	content: string;
	sha256: string | null;
}

interface GlobalDocWriteResult {
	sha256: string;
}

/** Basename of an absolute path (for the mono doc-name crumb). */
function basename(p: string): string {
	const parts = p.split(/[/\\]/);
	return parts[parts.length - 1] || p;
}

/**
 * Editor for a harness's USER-GLOBAL instruction doc (`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, …). Composes `DocumentEditorShell`. The target path is
 * resolved server-side from the harness id — the frontend never names it. A
 * drift-on-disk write is refused and surfaces an overwrite confirm.
 */
export function HarnessDocEditor() {
	const { id = "" } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const queryClient = useQueryClient();
	const harnesses = useHarnesses();
	const rescanHarnesses = useAppStore((s) => s.rescanHarnesses);

	const [content, setContent] = useState("");
	const [original, setOriginal] = useState("");
	const [loadedSha, setLoadedSha] = useState<string | null>(null);
	const [loadedForPath, setLoadedForPath] = useState<string | null>(null);
	const [mode, setMode] = useState<DocMode>("edit");
	const [saving, setSaving] = useState(false);
	const [driftOpen, setDriftOpen] = useState(false);

	// The harness list drives the label + glyph. It may still be loading on a
	// direct deep-link; fall back to the identity registry for known ids.
	const status = harnesses.find((h) => h.id === id);
	const label = harnessLabel(id);
	const isKnownHarness = harnesses.length === 0 || status != null;

	const query = useQuery({
		queryKey: ["global-doc", id],
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

	// Unknown harness id → honest dead-end with a way back (mirrors HarnessConfig).
	if (id && harnesses.length > 0 && !status) {
		return (
			<>
				<ScreenHeader
					back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
					title={label}
					leading={<HarnessGlyph id={id} label={label} size={20} decorative />}
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
					leading={<HarnessGlyph id={id} label={label} size={20} decorative />}
				/>
				<EmptyState
					icon="warning"
					title="Couldn't load the instruction file"
					description={String(query.error)}
				/>
			</>
		);
	}

	if (!doc) return null;

	const dirty = content !== original;
	const missing = !doc.exists && original === "";
	const lineCount = content === "" ? 0 : content.split("\n").length;
	const bytes = new TextEncoder().encode(content).length;
	const fileName = basename(doc.path);

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
			await queryClient.invalidateQueries({ queryKey: ["global-doc", id] });
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
		const fresh = await query.refetch();
		if (fresh.data) {
			setContent(fresh.data.content);
			setOriginal(fresh.data.content);
			setLoadedSha(fresh.data.sha256);
			setLoadedForPath(fresh.data.path);
			toast.push({
				kind: "info",
				title: `Reloaded ${fileName}`,
				body: "Discarded your unsaved edits for the on-disk version.",
			});
		}
	}

	return (
		<>
			<ScreenHeader
				back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
				leading={<HarnessGlyph id={id} label={label} size={20} decorative />}
				title={label}
				crumbs={[
					<span key="doc" className="text-mono">
						{fileName}
					</span>,
				]}
				subline="User-global instructions this harness reads for every session"
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
					<div className="side-panel-block">
						{missing && (
							<InfoBanner style={{ marginBottom: 12 }}>
								This file doesn't exist yet — saving will create it at the path
								below.
							</InfoBanner>
						)}
						<MetaGrid>
							<Field label="harness" full>
								<span className="text-mono">{id}</span>
							</Field>
							<Field label="path" full>
								<span className="text-mono harness-doc-path">{doc.path}</span>
							</Field>
							<Field label="state">
								<span className="text-mono">
									{doc.exists ? "on disk" : "not created"}
								</span>
							</Field>
							<Field label="size">
								<span className="text-mono">
									{lineCount} ln · {bytes} B
								</span>
							</Field>
						</MetaGrid>
					</div>
				}
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
		</>
	);
}
