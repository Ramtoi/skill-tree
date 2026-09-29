// ─── Edit mode: the CodeMirror 6 skill-reference extension ───────────────────
// A bundle of four pieces (plans/2-editor.md §2 "Edit mode — decoration"):
//   1. a ViewPlugin decorating every `findRefs` hit as `.cm-skill-ref`,
//      rebuilt on `update.docChanged`;
//   2. a `hoverTooltip` (the sanctioned CM6 idiom) hosting the shared card via
//      `buildRefCardDom` — plain DOM, no React portal;
//   3. a `mousedown` handler that navigates on ⌘/Ctrl-click and `return
//      true`s so CodeMirror's own multi-cursor gesture never also fires; a
//      plain click is left alone and still places the caret;
//   4. window-scoped keydown/keyup/blur listeners toggling `.cm-skill-ref-mod`
//      on the editor DOM — editor-scoped listeners never fire while the
//      editor is unfocused, so a hover with the modifier held would
//      otherwise show a text cursor.
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type Tooltip,
	ViewPlugin,
	type ViewUpdate,
	hoverTooltip,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { findRefs, type SkillRefRenderOptions } from "@/lib/skillRefs";
import { buildRefCardDom } from "./SkillRefCard";

const MOD_CLASS = "cm-skill-ref-mod";

function buildDecorations(opts: SkillRefRenderOptions, doc: string): DecorationSet {
	const hits = findRefs(doc, opts.names, opts.self, opts.ignore);
	const builder = new RangeSetBuilder<Decoration>();
	for (const hit of hits) {
		builder.add(
			hit.offset,
			hit.offset + hit.length,
			Decoration.mark({
				class: "cm-skill-ref",
				attributes: { "data-ref": hit.name, "data-form": hit.form },
			}),
		);
	}
	return builder.finish();
}

/** The decorated-ref element a mouse event landed on, if any. Handles both an
 *  Element target and a bare Text node (mousedown can target either). */
function refElementFromTarget(target: EventTarget | null): HTMLElement | null {
	if (target instanceof Element) return target.closest(".cm-skill-ref");
	if (target instanceof Node) {
		return target.parentElement?.closest(".cm-skill-ref") ?? null;
	}
	return null;
}

/**
 * CodeMirror 6 extension bundle for skill-reference tokens: decoration,
 * 250ms hover card, ⌘/Ctrl-click navigation, and the modifier-held pointer
 * class. `opts` must be referentially stable across keystrokes — the caller
 * (`useSkillRefs`) memoizes it over `(names, self, ignore, describe, onOpen)`
 * and never over `content`, so this extension is never reconfigured mid-type.
 */
export function skillRefExtension(opts: SkillRefRenderOptions): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private readonly view: EditorView;
			private readonly onKeyDown = (event: KeyboardEvent) => {
				if (event.metaKey || event.ctrlKey) {
					this.view.dom.classList.add(MOD_CLASS);
				}
			};
			private readonly onKeyUp = (event: KeyboardEvent) => {
				if (!event.metaKey && !event.ctrlKey) {
					this.view.dom.classList.remove(MOD_CLASS);
				}
			};
			private readonly onBlur = () => {
				this.view.dom.classList.remove(MOD_CLASS);
			};

			constructor(view: EditorView) {
				this.view = view;
				this.decorations = buildDecorations(opts, view.state.doc.toString());
				window.addEventListener("keydown", this.onKeyDown);
				window.addEventListener("keyup", this.onKeyUp);
				window.addEventListener("blur", this.onBlur);
			}

			update(update: ViewUpdate) {
				if (update.docChanged) {
					this.decorations = buildDecorations(opts, update.state.doc.toString());
				}
			}

			destroy() {
				window.removeEventListener("keydown", this.onKeyDown);
				window.removeEventListener("keyup", this.onKeyUp);
				window.removeEventListener("blur", this.onBlur);
			}
		},
		{ decorations: (v) => v.decorations },
	);

	const hover = hoverTooltip(
		(view, pos): Tooltip | null => {
			const hits = findRefs(view.state.doc.toString(), opts.names, opts.self, opts.ignore);
			const hit = hits.find((h) => pos >= h.offset && pos <= h.offset + h.length);
			if (!hit) return null;
			return {
				pos: hit.offset,
				end: hit.offset + hit.length,
				above: true,
				create: () => ({
					dom: buildRefCardDom({
						name: hit.name,
						description: opts.describe(hit.name),
						showHint: true,
						onOpen: () => opts.onOpen(hit.name),
					}),
				}),
			};
		},
		{ hoverTime: 250 },
	);

	const clickHandler = EditorView.domEventHandlers({
		mousedown(event, _view) {
			if (!(event.metaKey || event.ctrlKey)) return false;
			const el = refElementFromTarget(event.target);
			const name = el?.dataset.ref;
			if (!name) return false;
			event.preventDefault();
			opts.onOpen(name);
			return true;
		},
	});

	return [plugin, hover, clickHandler];
}
