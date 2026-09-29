import { useEffect, useState } from "react";
import { CodeAreaEdit } from "@/components/CodeArea";

/** One file a `SourceViewer` can show a tab for. `body: null` renders
 *  `missingText` (or the generic "Could not read <label>." fallback) instead
 *  of the editor. */
export interface SourceFile {
	id: string;
	label: string;
	body: string | null;
	missingText?: string;
}

export interface SourceViewerProps {
	files: SourceFile[];
	/** Namespaces the tab/panel DOM ids so two instances on one screen never
	 *  collide (`${idPrefix}-tab-<i>` / `${idPrefix}-panel`). */
	idPrefix: string;
	ariaLabel: string;
	/** Selected tab resets to the first file whenever this changes (e.g. the
	 *  hook name — reopening a different hook must not leave a stale index). */
	resetKey?: string;
}

/**
 * A read-only source viewer: a file-tab strip (`role="tablist"`, Left/Right
 * arrow navigation) over one `role="tabpanel"` showing the active file's body
 * in a read-only `CodeAreaEdit`. Shared by the built-in hook's real body
 * (`hook.builtin.files`) and a command hook's detected script file(s)
 * (`command_script`) — same visual language, same 420px reading pane
 * (`.hook-builtin-source`), so a script reads the same wherever it is shown.
 *
 * Returns `null` for an empty file list (nothing to show).
 */
export function SourceViewer({ files, idPrefix, ariaLabel, resetKey }: SourceViewerProps) {
	const [idx, setIdx] = useState(0);

	useEffect(() => {
		setIdx(0);
	}, [resetKey]);

	if (files.length === 0) return null;
	const activeIdx = Math.min(idx, files.length - 1);
	const active = files[activeIdx];
	const panelId = `${idPrefix}-panel`;
	const tabId = (i: number) => `${idPrefix}-tab-${i}`;

	function move(delta: number) {
		const n = files.length;
		const next = (activeIdx + delta + n) % n;
		setIdx(next);
		document.getElementById(tabId(next))?.focus();
	}

	return (
		<>
			<div className="chips hook-builtin-files" role="tablist" aria-label={ariaLabel}>
				{files.map((f, i) => (
					<button
						key={f.id}
						type="button"
						id={tabId(i)}
						className="chip"
						role="tab"
						aria-selected={activeIdx === i}
						aria-controls={panelId}
						tabIndex={activeIdx === i ? 0 : -1}
						onClick={() => setIdx(i)}
						onKeyDown={(e) => {
							if (e.key === "ArrowRight") {
								e.preventDefault();
								move(1);
							} else if (e.key === "ArrowLeft") {
								e.preventDefault();
								move(-1);
							}
						}}
					>
						<span className="chip-label text-mono">{f.label}</span>
					</button>
				))}
			</div>
			{active.body === null ? (
				<p
					className="conn-hint hook-script-warn"
					id={panelId}
					role="tabpanel"
					aria-labelledby={tabId(activeIdx)}
				>
					{active.missingText ?? `Could not read ${active.label}.`}
				</p>
			) : (
				<div
					className="hook-script-body hook-builtin-source"
					id={panelId}
					role="tabpanel"
					aria-labelledby={tabId(activeIdx)}
				>
					<CodeAreaEdit content={active.body} onChange={() => {}} readOnly language="text" />
				</div>
			)}
		</>
	);
}
