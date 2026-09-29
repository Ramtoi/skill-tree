import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { CodeAreaEdit, CodeAreaPreview } from "@/components/CodeArea";
import { ConfirmDialog } from "@/components/Modal";
import { ResizableSplit } from "@/components/ResizableSplit";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { createSnippet, useInvalidateSnippets, useSnippetNames } from "@/hooks/useSnippets";
import { snippetBackTarget, type SnippetDraft } from "@/lib/backTarget";
import { useUnsavedGuard } from "@/lib/navGuard";
import { TagInput } from "@/components/snippets/TagInput";

// Duplicated on purpose (also in `SnippetEditor.tsx`) — a small literal, not
// worth a shared module and the import-cycle risk that would come with one
// (this file and `SnippetEditor.tsx` already reference each other).
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Deliberately the SAME key `SnippetEditor.tsx` uses — one snippet-authoring
 *  disclosure memory, shared between create and edit. */
const SNIPPET_EDITOR_SECTIONS_KEY = "st:snippet-editor:sections";

/** The create form's starting body — an untyped draft. Comparing against this
 *  (rather than truthiness) is what keeps the leave guard from arming on a
 *  fresh, untouched `/snippet/new`. */
const BODY_SEED = "## \n\n";

/**
 * `/snippet/new` — the create form, extracted from `SnippetEditor.tsx` (F10)
 * so that file stays under the module's line ceiling. Behavior is otherwise
 * unchanged from before the extraction, plus: skill-reference decoration +
 * hover + ⌘-click in the editor, a Preview link, a REFERENCES section, and a
 * `touched`-gated leave guard (F4) whose ref-click affordances never prompt
 * (F11) — a reference click runs through the host's `wrapNavigate` seam
 * (`leaveGuard.bypass`), and the draft rides home in the back target's
 * `restore` instead.
 */
export function SnippetCreateForm() {
	const navigate = useNavigate();
	const toast = useToast();
	const invalidate = useInvalidateSnippets();
	const [searchParams] = useSearchParams();
	const { state } = useLocation();
	const { data: registry } = useRegistry();

	const { data: lib = [] } = useSnippetNames();
	const existingNames = useMemo(() => new Set(lib.map((s) => s.name)), [lib]);
	const allTags = useMemo(
		() => [...new Set(lib.flatMap((s) => s.tags))].sort(),
		[lib],
	);

	const [name, setName] = useState("");
	const [desc, setDesc] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [body, setBody] = useState(BODY_SEED);
	const [prefilled, setPrefilled] = useState(false);

	/** F4: armed only once a person actually typed something — never by the
	 *  `?name=` prefill effect below, and never by an untouched, freshly
	 *  mounted form. Set by the four onChange handlers, and by the draft
	 *  restore seed (a restored draft is, by definition, already touched). */
	const [touched, setTouched] = useState(false);

	// F11: a one-shot restore of the draft carried home in `restore.snippetDraft`
	// (`lib/backTarget.ts`'s `snippetBackTarget`) — the explicit back-arrow
	// path only; a browser history pop never carries router state. Declared
	// BEFORE the `?name=` prefill effect below so both effects, triggered by
	// the same mount, run in that order within the same commit — letting the
	// prefill effect read `draftRestoredRef` synchronously, across the two
	// separate `useEffect` calls, without waiting on a re-render.
	const draftRestoredRef = useRef(false);
	const [seeded, setSeeded] = useState(false);
	useEffect(() => {
		if (seeded) return;
		setSeeded(true);
		const raw = (state as { snippetDraft?: unknown } | null)?.snippetDraft;
		if (!raw || typeof raw !== "object") return;
		const d = raw as Partial<SnippetDraft>;
		if (typeof d.name === "string") setName(d.name);
		if (typeof d.desc === "string") setDesc(d.desc);
		if (Array.isArray(d.tags) && d.tags.every((t) => typeof t === "string")) {
			setTags(d.tags);
		}
		if (typeof d.body === "string") setBody(d.body);
		draftRestoredRef.current = true;
		setTouched(true);
	}, [state, seeded]);

	// `?name=<prefill>` (the palette's "New snippet…" verb) — applied once, so
	// typing over it afterward is never fought. Skipped when a draft was
	// restored above: the draft already carries whatever name the author had
	// typed, and the prefill must not clobber it.
	useEffect(() => {
		if (prefilled) return;
		setPrefilled(true);
		if (draftRestoredRef.current) return;
		const prefill = searchParams.get("name");
		if (prefill) setName(prefill.toLowerCase());
	}, [searchParams, prefilled]);

	const draft: SnippetDraft = { name, desc, tags, body };
	// F3/F11: a reference click must never trip the leave guard — the draft
	// rides home in `restore` instead of being lost. `leaveGuard` runs before
	// `useSkillRefs` so its `bypass` is ready to hand in as the host's
	// `wrapNavigate`.
	const leaveGuard = useUnsavedGuard(touched);
	const host = { back: snippetBackTarget("", draft), wrapNavigate: leaveGuard.bypass };
	const refs = useSkillRefs({ host, content: body, registry });

	const nameErr = !name
		? null
		: !NAME_RE.test(name)
			? "Use lowercase kebab-case (letters, digits, single hyphens)."
			: existingNames.has(name)
				? `A snippet named "${name}" already exists.`
				: null;
	const canCreate = !nameErr && !!name;
	const [creating, setCreating] = useState(false);

	async function create() {
		if (!canCreate) return;
		setCreating(true);
		try {
			await createSnippet({ name, description: desc, tags, body });
			toast.success(`Created ${name}`, "added to the library");
			invalidate();
			// The write just landed — nothing left to lose, so this navigation
			// must not be questioned by the leave guard (F3).
			leaveGuard.bypass(() =>
				navigate(`/snippet/${encodeURIComponent(name)}`, { replace: true }),
			);
		} catch (err) {
			toast.error("Couldn't create snippet", String(err));
		} finally {
			setCreating(false);
		}
	}

	return (
		<>
			<ScreenHeader
				back={{ label: "Snippets", onClick: () => navigate("/snippets") }}
				nameMono="new snippet"
				crumbs={["snippets", "new"]}
				primary={
					<Button
						variant="primary"
						icon="plus"
						busy={creating}
						disabled={!canCreate}
						onClick={() => void create()}
					>
						Create snippet
					</Button>
				}
			/>

			<ResizableSplit
				className="editor-grid snip-create"
				fixedPane="right"
				storageKey="st:layout:snippet-new"
				defaultRightPx={332}
				minRightPx={280}
				maxRightPx={520}
				paneLabel="Details"
				handleAriaLabel="Resize details panel"
				left={
					<div className="editor-main">
						<div className="meta-grid snip-meta">
							<div className="field field-full">
								<label>
									name <span className="text-dim">· lowercase kebab-case</span>
								</label>
								<input
									value={name}
									autoFocus
									onChange={(e) => {
										setName(e.target.value.toLowerCase());
										setTouched(true);
									}}
									placeholder="e.g. validation-procedure"
									spellCheck={false}
								/>
								<div
									className="field-hint"
									style={{ color: nameErr ? "var(--red)" : "var(--fg-dim)" }}
								>
									{nameErr ? (
										<>
											<Icon name="warning" size={11} /> {nameErr}
										</>
									) : (
										<>used as the marker id in every file it&rsquo;s applied to</>
									)}
								</div>
							</div>
							<div className="field field-full">
								<label>description</label>
								<input
									value={desc}
									onChange={(e) => {
										setDesc(e.target.value);
										setTouched(true);
									}}
									placeholder="One line — what this snippet instructs"
								/>
							</div>
							<div className="field field-full">
								<label>tags</label>
								<TagInput
									tags={tags}
									onChange={(t) => {
										setTags(t);
										setTouched(true);
									}}
									suggestions={allTags}
								/>
							</div>
						</div>

						<div className="snip-code">
							<CodeAreaEdit
								content={body}
								onChange={(v) => {
									setBody(v);
									setTouched(true);
								}}
								extraExtensions={refs.extension}
							/>
						</div>

						<div className="editor-foot">
							<span>
								<Icon name="doc" size={10} /> markdown snippet
							</span>
							<span>
								{body.split("\n").length} lines · {body.length} chars
							</span>
							<span className="editor-foot-spacer" />
							<span>{canCreate ? "ready to create" : "name required"}</span>
						</div>
					</div>
				}
				right={
					<div className="editor-side">
						<div className="side-panel-block">
							<h4>About snippets</h4>
							<div className="snip-marker-hint">
								A reusable markdown block, applied to any project&rsquo;s agent doc
								file and tracked there afterward.
							</div>
						</div>

						{registry && (
							<SkillRefsSection
								host={host}
								content={body}
								registry={registry}
								storageKey={SNIPPET_EDITOR_SECTIONS_KEY}
							/>
						)}

						<div className="side-panel-block">
							<h4>Preview</h4>
							<div className="snip-create-preview">
								<CodeAreaPreview content={body} skillRefs={refs.render} />
							</div>
						</div>
					</div>
				}
			/>

			{/* F4: armed only once `touched`. A reference click never raises this
			    prompt — it runs through `leaveGuard.bypass` (F11) — and the draft
			    is carried home lossless instead. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Discard this draft?"
				body="This snippet has not been created yet. Leaving loses the draft."
				confirmLabel="Discard"
				cancelLabel="Stay"
				tone="danger"
			/>
		</>
	);
}
