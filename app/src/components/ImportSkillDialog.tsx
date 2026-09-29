import { useEffect, useState } from "react";
import { hubCmd } from "@/lib/hubCmd";
import { ConfirmDialog } from "./Modal";
import { Tag } from "./Tag";
import { Field } from "./Field";
import {
	SKILL_SLUG_RE,
	parseCliJson,
	type SkillPackImportResult,
	type SkillPackPreview,
} from "@/lib/skillPack";

export interface ImportSkillDialogProps {
	open: boolean;
	/** Absolute path of the `.skillpack` file being imported. */
	filePath: string;
	/** Dry-run payload from `hub skill import <file> --dry-run --json`. */
	preview: SkillPackPreview | null;
	onClose: () => void;
	/** Called with the imported skill's final name after a successful apply. */
	onImported: (name: string) => void;
}

function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Preview-then-confirm for a `.skillpack` import. The dry-run payload is
 * resolved by the caller (the Library's Import button) so the dialog opens
 * already knowing whether the pack is valid; this component owns only the
 * collision override + the apply round-trip.
 *
 * Confirm stays gated until the pack is valid AND — when the CLI reported a
 * name collision — a syntactically valid override has been typed, so the
 * destructive "refuse or rename" decision is made before the write, not after.
 */
export function ImportSkillDialog({
	open,
	filePath,
	preview,
	onClose,
	onImported,
}: ImportSkillDialogProps) {
	const [override, setOverride] = useState("");
	// Whether the rename field is on screen. Tracked separately from `override`
	// so clearing the input does NOT yank the field out from under the cursor.
	const [renaming, setRenaming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset per-open so a second import never inherits the first one's override.
	useEffect(() => {
		if (!open) return;
		setOverride("");
		setRenaming(false);
		setBusy(false);
		setError(null);
	}, [open, filePath]);

	if (!open) return null;

	const valid = !!preview?.valid;
	const collision = !!preview?.collision;
	const overrideTrimmed = override.trim();
	const overrideValid = SKILL_SLUG_RE.test(overrideTrimmed);
	// A collision REQUIRES a rename; without one the CLI would refuse anyway.
	const overrideSatisfied = collision ? overrideValid : true;
	// An override is optional when there is no collision, but if typed it must
	// still be a legal slug — otherwise the apply is a guaranteed refusal.
	const overrideWellFormed =
		collision || overrideTrimmed === "" || overrideValid;
	const finalName = overrideTrimmed || preview?.name || "";

	async function apply() {
		if (busy || !preview) return;
		setBusy(true);
		setError(null);
		try {
			const args = ["skill", "import", filePath, "--json"];
			if (overrideTrimmed) args.push("--name", overrideTrimmed);
			const result = await hubCmd(args);
			if (!result.success) {
				// A refusal answers with `{"error": "..."}` — show the sentence, not
				// the JSON envelope.
				let message = result.output || "import failed";
				try {
					const payload = parseCliJson<{ error?: string }>(result.output);
					if (payload?.error) message = payload.error;
				} catch {
					/* not JSON — the raw text is the message */
				}
				throw new Error(message);
			}
			// Tolerate a payload-less success (older CLI): fall back to finalName.
			let imported = finalName;
			try {
				imported =
					parseCliJson<SkillPackImportResult>(result.output).imported ||
					finalName;
			} catch {
				/* no JSON payload — the exit status already said it worked */
			}
			onImported(imported);
			onClose();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<ConfirmDialog
			open={open}
			// A cancel mid-write would orphan the in-flight apply; ConfirmDialog
			// already blocks Esc/backdrop while busy, so match that on the handler.
			onClose={() => {
				if (!busy) onClose();
			}}
			onConfirm={() => void apply()}
			title="Import skill pack"
			width={560}
			confirmLabel={busy ? "Importing…" : "Import"}
			confirmIcon="import"
			busy={busy}
			confirmDisabled={!valid || !overrideSatisfied || !overrideWellFormed}
			body={
				<div className="import-pack" data-testid="import-skill-dialog">
					<div className="import-pack-path" title={filePath}>
						{filePath}
					</div>

					{!preview && (
						<div className="import-pack-empty">Reading pack…</div>
					)}

					{preview && !valid && (
						<div
							role="alert"
							className="import-pack-errors"
							data-testid="import-pack-errors"
						>
							<strong>This pack cannot be imported.</strong>
							<ul>
								{(preview.errors?.length
									? preview.errors
									: ["Unrecognized or corrupt skill pack."]
								).map((e, i) => (
									<li key={i}>{e}</li>
								))}
							</ul>
						</div>
					)}

					{preview && valid && (
						<>
							<div className="import-pack-head">
								<span className="import-pack-name">{preview.name}</span>
								{/* A version is an identifier, not a category — the Tag's
								    uppercase would render it "V1.4.0". */}
								{preview.version && (
									<span className="import-pack-version">
										v{preview.version}
									</span>
								)}
								{preview.scope && (
									<Tag color="var(--fg-mute)">{preview.scope}</Tag>
								)}
							</div>
							{preview.description && (
								<p className="import-pack-desc">{preview.description}</p>
							)}

							<div className="import-pack-files">
								<div className="import-pack-files-head">
									{(preview.files ?? []).length} file
									{(preview.files ?? []).length === 1 ? "" : "s"}
								</div>
								<ul data-testid="import-pack-files">
									{(preview.files ?? []).map((f) => (
										<li key={f.path}>
											<span className="import-pack-file-path">{f.path}</span>
											<span className="import-pack-file-size">
												{formatBytes(f.bytes)}
											</span>
										</li>
									))}
								</ul>
							</div>

							{collision && (
								<div
									className="import-pack-collision"
									data-testid="import-pack-collision"
									role="alert"
								>
									A skill named <code>{preview.name}</code> already exists
									{preview.existing?.version
										? ` (v${preview.existing.version})`
										: ""}
									. Give the imported copy a different name to keep both.
								</div>
							)}

							{(collision || renaming) && (
								<Field
									label="import as"
									full
									hint={
										overrideTrimmed !== "" && !overrideValid
											? "Lowercase letters, numbers, and hyphens only."
											: `Will be registered as ${finalName || "…"}`
									}
								>
									<input
										value={override}
										onChange={(e) => setOverride(e.target.value)}
										placeholder={`${preview.name}-2`}
										aria-label="Import as name"
										aria-invalid={
											overrideTrimmed !== "" && !overrideValid ? true : undefined
										}
										disabled={busy}
									/>
								</Field>
							)}

							{!collision && !renaming && (
								<button
									type="button"
									className="import-pack-rename"
									onClick={() => {
										setRenaming(true);
										setOverride(preview.name);
									}}
								>
									Import under a different name…
								</button>
							)}
						</>
					)}

					{error && (
						<div role="alert" className="import-pack-error">
							{error}
						</div>
					)}
				</div>
			}
		/>
	);
}
