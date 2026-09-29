/**
 * Emoji picker for the New-bundle icon field: search, a grouped tile grid
 * with sticky section heads, per-grid keyboard navigation (roving tabindex —
 * one tab stop for the group strip, one for the grid), and a footer preview.
 * Lives inside the shared `<Popover>` — this component owns none of the
 * anchoring/outside-click mechanics, only its own content, its own Escape
 * (the host Popover handles outside-click; Modal owns the dialog's own
 * Escape, which this component must not also trigger), and its own Tab-exit
 * (tabbing past either end hands off to the caller's `onClose` rather than
 * leaving the browser to pick where focus lands next).
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../Icon";
import { Kbd } from "../Kbd";
import { isValidIcon } from "../IconPicker";
import { EMOJI_GROUPS, searchEmoji, type EmojiEntry } from "./emojiData";

export interface EmojiPickerProps {
  value: string;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

/** macOS is the only platform with the ⌃⌘Space palette — don't promise it
 *  elsewhere. Duplicated from `IconPicker.tsx` (not exported there): six
 *  lines are cheaper than a shared module for this one check. */
function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = `${navigator.userAgent ?? ""} ${
    (navigator as unknown as { platform?: string }).platform ?? ""
  }`;
  return /mac|darwin|iphone|ipad/i.test(ua);
}

function findEntryByChar(char: string): EmojiEntry | undefined {
  for (const group of EMOJI_GROUPS) {
    const hit = group.entries.find((e) => e.char === char);
    if (hit) return hit;
  }
  return undefined;
}

/** Emoji-ish, duplicated from `IconPicker.tsx` (not exported there — see its
 *  own comment on the same regex): distinguishes "this query contains an
 *  emoji glyph" (a paste that isn't a single valid icon, e.g. two emoji back
 *  to back) from an ordinary text search that simply has no matches. */
const EMOJI_ISH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u;

/** Tiles are found by DOM query at keydown time (no index bookkeeping): the
 *  visible set changes shape between the grouped view and search results. */
function visibleTiles(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".emoji-picker-tile"));
}

/** Every grid the tile scroller currently renders, in DOM order — one grid
 *  per group when browsing, or the single combined results grid while
 *  searching. Arrow-key vertical steps stay inside a grid's own 8-column
 *  shape instead of sliding across the flat tile list (which misaligns the
 *  column at every group boundary). */
function visibleGrids(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(".emoji-picker-grid"));
}

function tilesInGrid(grid: HTMLElement): HTMLButtonElement[] {
  return Array.from(grid.querySelectorAll<HTMLButtonElement>(".emoji-picker-tile"));
}

function focusTile(tile: HTMLButtonElement) {
  tile.focus();
  tile.scrollIntoView({ block: "nearest" });
}

const GRID_COLS = 8;

export function EmojiPicker({ value, onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [activeGroupId, setActiveGroupId] = useState<string>(EMOJI_GROUPS[0]?.id ?? "");
  const [hovered, setHovered] = useState<{ char: string; name: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  const searching = trimmed.length > 0;
  const results = searching ? searchEmoji(trimmed) : [];
  const typedIsValid = searching && isValidIcon(trimmed);
  const typedAlreadyShown = results.some((r) => r.char === trimmed);
  const showTypedTile = typedIsValid && !typedAlreadyShown;
  const showEmptyState = searching && results.length === 0 && !typedIsValid;
  // A query with an emoji-ish char that still failed `isValidIcon` pasted
  // more than one glyph (a single stray emoji with no dataset match instead
  // falls through to `showTypedTile`) — name that mistake instead of
  // reporting "no match" for a query that plainly has an emoji in it.
  const showTwoEmojiState = showEmptyState && EMOJI_ISH.test(trimmed);

  // Roving tabindex (one tab stop for the whole grid): the tile matching the
  // current value if it's visible, else the first visible tile.
  const flatVisibleChars = searching
    ? [...(showTypedTile ? [trimmed] : []), ...results.map((r) => r.char)]
    : EMOJI_GROUPS.flatMap((g) => g.entries.map((e) => e.char));
  const rovingChar = flatVisibleChars.includes(value) ? value : flatVisibleChars[0];

  function hoverTile(entry: { char: string; name: string }) {
    setHovered({ char: entry.char, name: entry.name });
  }
  function clearHover() {
    setHovered(null);
  }

  function handleTileKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const container = scrollRef.current;
    if (!container) return;
    if (e.key === "Home" || e.key === "End") {
      const tiles = visibleTiles(container);
      const idx = tiles.indexOf(e.currentTarget);
      if (idx === -1) return;
      e.preventDefault();
      focusTile(tiles[e.key === "Home" ? 0 : tiles.length - 1]);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const tiles = visibleTiles(container);
      const idx = tiles.indexOf(e.currentTarget);
      if (idx === -1) return;
      const next = idx + (e.key === "ArrowLeft" ? -1 : 1);
      if (next < 0 || next >= tiles.length) return;
      e.preventDefault();
      focusTile(tiles[next]);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    // Each group (or the single results set while searching) is its own
    // 8-column grid — step within it, and hand off to the next/previous
    // grid's matching column at a boundary, instead of a flat ±8 that lands
    // on the wrong column the moment the grids don't line up.
    const grid = e.currentTarget.closest<HTMLElement>(".emoji-picker-grid");
    if (!grid) return;
    const grids = visibleGrids(container);
    const gridIdx = grids.indexOf(grid);
    if (gridIdx === -1) return;
    const tiles = tilesInGrid(grid);
    const i = tiles.indexOf(e.currentTarget);
    if (i === -1) return;
    const col = i % GRID_COLS;
    if (e.key === "ArrowDown") {
      if (i + GRID_COLS < tiles.length) {
        e.preventDefault();
        focusTile(tiles[i + GRID_COLS]);
        return;
      }
      const nextGrid = grids[gridIdx + 1];
      const nextTiles = nextGrid ? tilesInGrid(nextGrid) : [];
      if (nextTiles.length === 0) return; // last grid — stay put
      e.preventDefault();
      focusTile(nextTiles[Math.min(col, nextTiles.length - 1)]);
    } else {
      if (i - GRID_COLS >= 0) {
        e.preventDefault();
        focusTile(tiles[i - GRID_COLS]);
        return;
      }
      const prevGrid = grids[gridIdx - 1];
      const prevTiles = prevGrid ? tilesInGrid(prevGrid) : [];
      if (prevTiles.length === 0) return; // first grid — stay put
      const lastRowStart = Math.floor((prevTiles.length - 1) / GRID_COLS) * GRID_COLS;
      e.preventDefault();
      focusTile(prevTiles[Math.min(lastRowStart + col, prevTiles.length - 1)]);
    }
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    const first = visibleTiles(scrollRef.current)[0];
    first?.focus();
  }

  function handleTabClick(groupId: string) {
    setActiveGroupId(groupId);
    sectionRefs.current[groupId]?.scrollIntoView({ block: "start" });
  }

  function handleScroll() {
    if (searching) return;
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let current = activeGroupId;
    for (const group of EMOJI_GROUPS) {
      const el = sectionRefs.current[group.id];
      if (!el) continue;
      const top = el.getBoundingClientRect().top - containerTop;
      // A header still above the scroll-padding reserved for the sticky
      // head (see `.emoji-picker-scroll { scroll-padding-top: 26px }`) is
      // the one currently "at" the top.
      if (top <= 28) current = group.id;
    }
    if (current !== activeGroupId) setActiveGroupId(current);
  }

  function onKeyDownRoot(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // The host Popover would also close on Escape; the Modal underneath it
      // owns Escape too. Neither should also see this key — only the picker
      // closes, the dialog it lives inside stays open.
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Roving tabindex means the grid and the search input are the only two
    // tab stops. Tab forward out of the grid, or Shift+Tab back out of the
    // search input, would otherwise land wherever the browser's tab order
    // sends it next (outside this popover entirely) — close deterministically
    // and hand focus back to the trigger instead (`IconField.closePicker`).
    // Tab from the search input to the group strip, and from the strip into
    // the grid, are both a normal in-panel tab stop and stay untouched.
    const target = e.target as HTMLElement;
    const isTile = target.classList.contains("emoji-picker-tile");
    const isSearch = target === searchRef.current;
    if ((e.shiftKey && isSearch) || (!e.shiftKey && isTile)) {
      e.preventDefault();
      onClose();
    }
  }

  const previewGlyph = hovered?.char ?? value;
  const previewName = hovered?.name ?? findEntryByChar(value)?.name ?? "Pick an icon";

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- this div only intercepts Escape so the host Popover/Modal don't also see it (see `onKeyDownRoot`); every real control inside (input, tab, tile) is its own focusable, interactive element.
    <div className="emoji-picker" onKeyDown={onKeyDownRoot}>
      <div className="emoji-picker-search">
        <div className="search-input">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            aria-label="Search emoji"
            placeholder="Search emoji…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </div>
      </div>

      {!searching && (
        <div className="emoji-picker-tabs" role="group" aria-label="Emoji groups">
          {EMOJI_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-pressed={group.id === activeGroupId}
              tabIndex={group.id === activeGroupId ? 0 : -1}
              title={group.label}
              aria-label={group.label}
              className="emoji-picker-tab"
              onClick={() => handleTabClick(group.id)}
            >
              {group.glyph}
            </button>
          ))}
        </div>
      )}

      <div className="emoji-picker-scroll" ref={scrollRef} onScroll={handleScroll}>
        {searching ? (
          showEmptyState ? (
            <div className="emoji-picker-empty">
              {showTwoEmojiState ? (
                <div>One emoji at a time.</div>
              ) : (
                <>
                  <div>
                    No emoji match <b>“{trimmed}”</b>
                  </div>
                  <div>Paste any emoji here to use it.</div>
                </>
              )}
            </div>
          ) : (
            <div className="emoji-picker-section" data-group="results">
              <div className="emoji-picker-section-head">Results</div>
              <div className="emoji-picker-grid" role="group" aria-label="Results">
                {showTypedTile && (
                  <button
                    type="button"
                    className="emoji-picker-tile"
                    aria-label={`Use ${trimmed}`}
                    aria-pressed={trimmed === value}
                    tabIndex={trimmed === rovingChar ? 0 : -1}
                    title="Use as typed"
                    data-char={trimmed}
                    data-typed=""
                    onClick={() => onPick(trimmed)}
                    onMouseEnter={() => hoverTile({ char: trimmed, name: "Typed" })}
                    onFocus={() => hoverTile({ char: trimmed, name: "Typed" })}
                    onMouseLeave={clearHover}
                    onKeyDown={handleTileKeyDown}
                  >
                    {trimmed}
                  </button>
                )}
                {results.map((entry) => (
                  <button
                    key={entry.char}
                    type="button"
                    className="emoji-picker-tile"
                    aria-label={`Use ${entry.char}`}
                    aria-pressed={entry.char === value}
                    tabIndex={entry.char === rovingChar ? 0 : -1}
                    title={entry.name}
                    data-char={entry.char}
                    onClick={() => onPick(entry.char)}
                    onMouseEnter={() => hoverTile(entry)}
                    onFocus={() => hoverTile(entry)}
                    onMouseLeave={clearHover}
                    onKeyDown={handleTileKeyDown}
                  >
                    {entry.char}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          EMOJI_GROUPS.map((group) => (
            <div
              key={group.id}
              className="emoji-picker-section"
              data-group={group.id}
              ref={(el) => {
                sectionRefs.current[group.id] = el;
              }}
            >
              <div className="emoji-picker-section-head">{group.label}</div>
              <div className="emoji-picker-grid" role="group" aria-label={group.label}>
                {group.entries.map((entry) => (
                  <button
                    key={entry.char}
                    type="button"
                    className="emoji-picker-tile"
                    aria-label={`Use ${entry.char}`}
                    aria-pressed={entry.char === value}
                    tabIndex={entry.char === rovingChar ? 0 : -1}
                    title={entry.name}
                    data-char={entry.char}
                    onClick={() => onPick(entry.char)}
                    onMouseEnter={() => hoverTile(entry)}
                    onFocus={() => hoverTile(entry)}
                    onMouseLeave={clearHover}
                    onKeyDown={handleTileKeyDown}
                  >
                    {entry.char}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="emoji-picker-foot">
        <span className="emoji-picker-preview-glyph">{previewGlyph}</span>
        <span className="emoji-picker-preview-name">{previewName}</span>
        {isMacLike() && (
          <span className="emoji-picker-foot-sys">
            System picker <Kbd>⌃⌘Space</Kbd>
          </span>
        )}
      </div>
    </div>
  );
}
