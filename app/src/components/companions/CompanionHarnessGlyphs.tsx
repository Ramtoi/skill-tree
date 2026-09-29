// D7/S4 — the harness glyph cluster: presence-dimmed identity marks, never
// verdict words. `HarnessGlyph` itself stays untouched (W10) — this wraps it
// so the STATE (lit/dim/unsupported) lives on an outer `<span>` the primitive
// doesn't know about, alongside an aria-label + a visually-hidden sentence so
// the state is never colour/opacity alone (S4: "identity glyph, presence-
// dimmed — identity without chroma").

import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { glyphStateFor, type CompanionState } from "@/lib/companions";

/** One harness's live state for a companion — the shape both this cluster and
 *  `CompanionRefCard`'s hover row consume (D8's `CompanionHarnessState`). */
export interface CompanionHarnessState {
	harness: string;
	state: CompanionState;
	reason?: string | null;
}

/** Full sentence per raw `CompanionState` — used as the wrapper's `title`,
 *  `aria-label`, AND its sr-only child text (belt-and-suspenders: a screen
 *  reader gets the sentence, a sighted mouse user gets the same words on
 *  hover, and a test can query either). `reason` (present on `unsupported`,
 *  sometimes on others) is appended verbatim — never invented here. */
function stateSentence(harness: string, state: CompanionState, reason?: string | null): string {
	const label = harnessLabel(harness);
	const base = ((): string => {
		switch (state) {
			case "provisioned":
				return `Provisioned on ${label}`;
			case "present":
				return `Present on ${label}`;
			case "drift":
				return `Provisioned on ${label} — drifted from the skill's copy`;
			case "outdated":
				return `Provisioned on ${label} — re-synced after a definition change`;
			case "pending":
				return `Declared, not yet provisioned on ${label}`;
			case "absent":
				// D15/F1: no imperative — a project-less read genuinely cannot
				// see project-scoped hooks/rules, so this must stay true both
				// before AND after the reader equips the skill (D17's
				// `provisioned` state, not this one, carries the post-equip
				// truth; see `reason`, appended below, for D17's "on <scopes>").
				return `Declared by the skill — not found on ${label}`;
			case "unsupported":
				return `Not supported on ${label}`;
			case "missing":
				return `Missing on ${label}`;
			case "stale":
				return `No longer declared on ${label}`;
			default:
				return label;
		}
	})();
	return reason ? `${base}: ${reason}` : base;
}

export interface CompanionHarnessGlyphsProps {
	states: CompanionHarnessState[];
	size?: number;
	className?: string;
}

/**
 * The row/hover-card glyph cluster: one glyph per harness the live read
 * reported, in the order given (a caller sorts by its own display order — this
 * component never reorders). A `state` whose glyph register is `"none"`
 * (`missing`/`stale`, D7 Risk 3) lights nothing at all — the row's own neutral
 * `Tag` carries that state instead, so this cluster silently omits it rather
 * than rendering an empty/invisible glyph.
 */
export function CompanionHarnessGlyphs({ states, size = 14, className }: CompanionHarnessGlyphsProps) {
	const visible = states.filter((s) => glyphStateFor(s.state) !== "none");
	if (visible.length === 0) return null;
	return (
		<span className={["companion-glyphs", className].filter(Boolean).join(" ")}>
			{visible.map((s) => {
				const glyphState = glyphStateFor(s.state);
				const sentence = stateSentence(s.harness, s.state, s.reason);
				return (
					<span
						key={s.harness}
						className="companion-glyph"
						role="img"
						data-harness={s.harness}
						data-state={glyphState}
						title={sentence}
						aria-label={sentence}
					>
						<HarnessGlyph id={s.harness} size={size} decorative />
						<span className="sr-only">{sentence}</span>
					</span>
				);
			})}
		</span>
	);
}
