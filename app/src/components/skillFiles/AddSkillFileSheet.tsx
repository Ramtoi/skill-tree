import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { ChipRadios } from "@/components/ChipRadios";
import { Field } from "@/components/Field";
import { Sheet } from "@/components/Modal";
import { createSkillFile, skillFileErrorKind } from "@/lib/skillFiles";
import {
	absorbTypedPath,
	relForKind,
	SKILL_FILE_KIND_META,
	SKILL_FILE_KINDS,
	type SkillFileKind,
} from "@/lib/skillFileKinds";
import { validateNewFileRel } from "@/lib/skillFileTree";

export interface AddSkillFileSheetProps {
	open: boolean;
	skillName: string;
	onClose: () => void;
	/** Fired with the created rel path — the caller refreshes and selects it. */
	onCreated: (rel: string) => void;
}

/** Map the backend's stable error prefixes onto copy the author can act on. */
function messageFor(err: unknown): string {
	switch (skillFileErrorKind(err)) {
		case "exists":
			return "Something already exists at that path.";
		case "outside":
			return "That path would leave the skill folder.";
		case "read_only":
			return "This skill is managed by a source — duplicate it as local first.";
		default:
			return String(err instanceof Error ? err.message : err);
	}
}

const KIND_OPTIONS = SKILL_FILE_KINDS.map((kind) => ({
	value: kind,
	label: SKILL_FILE_KIND_META[kind].label,
	title: SKILL_FILE_KIND_META[kind].consequence,
}));

/**
 * New-file dialog. A skill's files take three shapes under the Agent Skills
 * layout — `references/`, `scripts/`, `assets/` — so the sheet leads with
 * the KIND (a chip row, Reference chosen by default) and the chosen folder
 * becomes a fixed prefix on the path field; the author types only the name.
 * `Other` frees the whole path. The two never disagree: a pasted full path
 * moves the kind chip and drops its folder from the name (`absorbTypedPath`).
 * Missing folders are created, and anything absolute, `..`-bearing or
 * resolving outside the skill dir is refused inline before it is sent.
 */
export function AddSkillFileSheet({
	open,
	skillName,
	onClose,
	onCreated,
}: AddSkillFileSheetProps) {
	const [kind, setKind] = useState<SkillFileKind>("reference");
	const [rest, setRest] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Focused imperatively rather than with `autoFocus`, which
	// `jsx-a11y/no-autofocus` flags (the rule's concern is a page-load steal,
	// not a modal's sole text field).
	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const meta = SKILL_FILE_KIND_META[kind];
	const rel = relForKind(kind, rest.trim());

	const close = useCallback(() => {
		setKind("reference");
		setRest("");
		setError(null);
		setBusy(false);
		onClose();
	}, [onClose]);

	const submit = useCallback(async () => {
		if (busy) return;
		// Under a folder prefix the field is a NAME; the generic "enter a path"
		// message would tell the author to type the folder again.
		const local = !rest.trim()
			? meta.folder
				? "Enter a file name."
				: validateNewFileRel("")
			: validateNewFileRel(rel);
		if (local) {
			setError(local);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await createSkillFile(skillName, rel);
			setKind("reference");
			setRest("");
			setBusy(false);
			onCreated(rel);
			onClose();
		} catch (err: unknown) {
			setBusy(false);
			setError(messageFor(err));
		}
	}, [busy, meta.folder, rel, rest, skillName, onCreated, onClose]);

	return (
		<Sheet
			open={open}
			onClose={close}
			title="Add file"
			width={480}
			footer={
				<>
					<Button variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button variant="primary" busy={busy} onClick={() => void submit()}>
						Create file
					</Button>
				</>
			}
		>
			<div className="sf-add-kind">
				<span className="sf-add-kind-label">kind</span>
				<ChipRadios
					name="skill-file-kind"
					label="Kind"
					value={kind}
					options={KIND_OPTIONS}
					onChange={(next) => {
						setKind(next);
						if (error) setError(null);
						inputRef.current?.focus();
					}}
					busy={busy}
				/>
				<p className="sf-add-kind-consequence" data-testid="skill-files-kind-consequence">
					{meta.consequence}
				</p>
			</div>
			<Field
				label="path"
				full
				htmlFor="skill-files-path"
				error={error}
				hint="Relative to the skill folder. Missing folders are created."
			>
				<div className="sf-path-input" data-kind={kind}>
					{meta.folder && (
						<span className="sf-path-prefix" data-testid="skill-files-prefix">
							{meta.folder}/
						</span>
					)}
					<input
						ref={inputRef}
						id="skill-files-path"
						data-testid="skill-files-path"
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "skill-files-path-error" : undefined}
						value={rest}
						placeholder={meta.placeholder}
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
						onChange={(e) => {
							const next = absorbTypedPath(kind, e.target.value);
							setKind(next.kind);
							setRest(next.rest);
							if (error) setError(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void submit();
								return;
							}
							// Backspace at the start of an empty name un-types the
							// prefix: the folder comes back as text under Other, the
							// inverse of `absorbTypedPath`, so the keyboard can leave a
							// kind it entered.
							if (
								e.key === "Backspace" &&
								meta.folder &&
								rest === "" &&
								(e.currentTarget.selectionStart ?? 0) === 0
							) {
								e.preventDefault();
								setKind("other");
								setRest(`${meta.folder}/`);
							}
						}}
					/>
				</div>
			</Field>
		</Sheet>
	);
}
