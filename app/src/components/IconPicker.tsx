/**
 * Emoji icon picker: a uniform, adaptive tile grid of common choices plus one
 * free-form slot that accepts ANY emoji. Controlled — owns no selection state
 * (the draft text of the custom slot is local, since a half-typed emoji is not
 * a selection yet).
 *
 * Selection lives on the tiles themselves: a custom emoji joins the grid as an
 * extra tile, so there is never a detached "preview" square to reconcile.
 */

import { useMemo, useState } from "react";
import { Kbd } from "./Kbd";

export const DEFAULT_ICON_CHOICES = [
  "📦",
  "🔧",
  "⚡",
  "🌿",
  "🤖",
  "🛠️",
  "🧪",
  "📜",
  "🔒",
  "🌐",
  "✨",
  "📁",
];

/**
 * Emoji-ish: a pictographic codepoint, a regional-indicator (flags — 🇩🇪 is two
 * regional indicators and carries NO pictographic codepoint), or a keycap
 * combiner (1️⃣, whose base is a plain digit). Keeps plain text ("hello", "x")
 * out while allowing ZWJ sequences, skin-tone modifiers, and variation
 * selectors.
 */
const EMOJI_ISH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u;

/** `Intl.Segmenter` is ES2022 and not in this project's TS lib — declare just
 *  the slice we use rather than widening the whole lib target. */
type SegmenterCtor = new (
  locales: string | undefined,
  options: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

/** Count user-perceived characters, so a ZWJ family (👨‍👩‍👧) reads as one. */
function graphemeCount(s: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor })
    .Segmenter;
  if (Segmenter) {
    return [
      ...new Segmenter(undefined, { granularity: "grapheme" }).segment(s),
    ].length;
  }
  // Fallback for engines without Intl.Segmenter: codepoints, not UTF-16 units.
  return [...s].length;
}

/** A value is usable as an icon when it is exactly one visible emoji. */
export function isValidIcon(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (!EMOJI_ISH.test(s)) return false;
  return graphemeCount(s) === 1;
}

/** macOS is the only platform with the ⌃⌘Space palette — don't promise it
 *  elsewhere. jsdom reports the host platform in its UA, so tests see it. */
function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = `${navigator.userAgent ?? ""} ${
    (navigator as unknown as { platform?: string }).platform ?? ""
  }`;
  return /mac|darwin|iphone|ipad/i.test(ua);
}

interface IconPickerProps {
  value: string;
  onChange: (icon: string) => void;
  choices?: string[];
}

export function IconPicker({
  value,
  onChange,
  choices = DEFAULT_ICON_CHOICES,
}: IconPickerProps) {
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState(false);

  const selected = value.trim();
  // A selection outside the preset set earns its own tile rather than living in
  // a separate preview square.
  const customTile = useMemo(
    () => (selected && !choices.includes(selected) ? selected : null),
    [selected, choices],
  );

  const tiles = customTile ? [...choices, customTile] : choices;

  function commit(raw: string) {
    setDraft(raw);
    if (!raw.trim()) {
      setRejected(false);
      return;
    }
    if (isValidIcon(raw)) {
      setRejected(false);
      setDraft("");
      onChange(raw.trim());
    } else {
      setRejected(true);
    }
  }

  return (
    <div className="icon-picker">
      <div className="icon-picker-grid" role="group" aria-label="Icon choices">
        {tiles.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`icon-picker-option${selected === opt ? " is-active" : ""}`}
            data-custom={opt === customTile || undefined}
            aria-pressed={selected === opt}
            aria-label={`Use ${opt}`}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      <div className="icon-picker-custom-row">
        <input
          className="icon-picker-custom"
          value={draft}
          onChange={(e) => commit(e.target.value)}
          placeholder="🙂"
          aria-label="Custom icon"
          aria-invalid={rejected || undefined}
        />
        <span className="icon-picker-hint">
          {rejected ? (
            <span className="icon-picker-hint-error">One emoji, please</span>
          ) : isMacLike() ? (
            <>
              Any emoji — <Kbd>⌃⌘Space</Kbd>
            </>
          ) : (
            <>Any emoji</>
          )}
        </span>
      </div>
    </div>
  );
}
