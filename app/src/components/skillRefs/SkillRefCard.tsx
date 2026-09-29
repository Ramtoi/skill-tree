// ─── The shared skill-reference hover card ───────────────────────────────────
// One card, two hosts: `SkillRefCard` is the React version Preview mounts on
// hover, `buildRefCardDom` is a plain-DOM equivalent the Edit-mode CodeMirror
// `hoverTooltip` hosts (a CM tooltip owns its own DOM node — no React portal,
// no anchorRef hack on a span CodeMirror manages). Both accept an optional
// `onOpen`: when present, the name renders as a real `<button>` so a reader
// who hovers the card can click through, not just ⌘-click the token itself.

export interface SkillRefCardInfo {
	name: string;
	description?: string;
	/** Edit mode only: the "⌘-click to open" secondary hint line. */
	showHint?: boolean;
}

const NO_DESCRIPTION = "No description.";

/** React host — mounted by Preview's hover-managed ref link. `<span>`s
 *  throughout (never `<div>`): the card can be mounted inside a `<p>` (a
 *  paragraph mentioning a skill), and a block element there is invalid HTML.
 *  The flex layout in `styles/skill-refs.css` does not care which tag it's
 *  applied to. */
export function SkillRefCard({
	name,
	description,
	showHint,
	onOpen,
}: SkillRefCardInfo & { onOpen?: () => void }) {
	return (
		<span className="skill-ref-card">
			{onOpen ? (
				<button
					type="button"
					className="skill-ref-card-name"
					onClick={onOpen}
				>
					{name}
				</button>
			) : (
				<span className="skill-ref-card-name">{name}</span>
			)}
			<span className="skill-ref-card-desc">{description || NO_DESCRIPTION}</span>
			{showHint && <span className="skill-ref-card-hint">⌘-click to open</span>}
		</span>
	);
}

/** Plain-DOM host — mounted by the Edit-mode `hoverTooltip` (refDecorations.ts). */
export function buildRefCardDom(
	info: SkillRefCardInfo & { onOpen?: () => void },
): HTMLElement {
	const { name, description, showHint, onOpen } = info;

	const card = document.createElement("div");
	card.className = "skill-ref-card";

	let nameEl: HTMLElement;
	if (onOpen) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "skill-ref-card-name";
		button.textContent = name;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			onOpen();
		});
		nameEl = button;
	} else {
		const span = document.createElement("span");
		span.className = "skill-ref-card-name";
		span.textContent = name;
		nameEl = span;
	}
	card.appendChild(nameEl);

	const desc = document.createElement("div");
	desc.className = "skill-ref-card-desc";
	desc.textContent = description || NO_DESCRIPTION;
	card.appendChild(desc);

	if (showHint) {
		const hint = document.createElement("div");
		hint.className = "skill-ref-card-hint";
		hint.textContent = "⌘-click to open";
		card.appendChild(hint);
	}

	return card;
}
