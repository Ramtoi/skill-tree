import { useCallback, useLayoutEffect, useState, type RefCallback } from "react";

/** Column gap fallback when `getComputedStyle` reports none (an unset
 *  `column-gap`/`gap` resolves to the keyword `"normal"`, which `parseFloat`
 *  turns into `NaN` — and jsdom, with no stylesheet engine, reports the same
 *  for a value it never computed at all). Matches `.main-subheader`'s own
 *  `gap: 10px` in `shell-main.css`. */
const GAP_FALLBACK_PX = 10;

export interface UseFitsInlineResult {
  /** Attach to the row element (`.main-subheader`). */
  rowRef: RefCallback<HTMLElement>;
  /** Attach to the right cluster (`.main-subheader-right`) — omit entirely
   *  for a subheader with no right cluster; a `null` node is treated as
   *  zero width. */
  rightRef: RefCallback<HTMLElement>;
  /** Attach to the content whose natural width is being measured. */
  contentRef: RefCallback<HTMLElement>;
  /** True while `contentRef`'s natural width fits on the same line as
   *  `rightRef`'s cluster, inside `rowRef`'s box. */
  fits: boolean;
}

/** Returns callback refs (not `RefObject`s from `useRef`) for exactly one
 *  reason: a subheader that is conditionally absent — the Library's is
 *  `undefined` while the registry itself is empty — mounts its row/right/
 *  content nodes for the FIRST time on some later render, after this hook's
 *  effect has already run once against `null`s and bailed out. A `useRef`
 *  object's identity never changes, so an effect keyed on `[rowRef,
 *  rightRef, contentRef]` would never re-run when `.current` later flips
 *  from `null` to a real element — the fit measurement would silently never
 *  attach. A callback ref's `setState` call on every mount/unmount instead
 *  produces a genuinely new dependency value each time, so the effect below
 *  re-runs exactly when the real DOM nodes actually change.
 *
 *  True while `contentRef`'s natural width fits **on the same line** as
 *  `rightRef`'s cluster, inside `rowRef`'s box.
 *
 *  Comparing `content.scrollWidth` against `rowRef`'s own flex child
 *  (`.main-subheader-left`) breaks the moment that child's layout changes
 *  shape for an unrelated reason — the `@container appmain (max-width:
 *  780px)` rule gives `.main-subheader-left` its own full row once the
 *  subheader wraps, so its `clientWidth` jumps up even though the facets and
 *  the right cluster still cannot share one line. Measuring against the ROW
 *  instead — `row.clientWidth` minus its own padding, minus the right
 *  cluster's rendered width, minus the column gap between them — answers the
 *  question that actually matters ("do these two clusters fit on one line
 *  together?") regardless of how the left child's own box happens to be
 *  shaped, so the fit/collapse decision is monotonic in the row's available
 *  width.
 *
 *  The content element must be `white-space: nowrap; flex-shrink: 0` so its
 *  `scrollWidth` is its natural single-line width whether it is laid out
 *  inline or parked off-flow for measuring (see `.library-facets` /
 *  `[data-collapsed]` in `equip-connections.css`) — the element stays in the
 *  DOM in both modes, so it is always measurable. A subheader with no right
 *  cluster simply never calls `rightRef`, which is the same "treat as zero
 *  width, skip the gap" state as a `null` node.
 *
 *  Default `true`: in jsdom every width reports `0`, so `0 <= 0` renders the
 *  inline layout by default in unit tests. A test that wants the collapsed
 *  path stubs `clientWidth` (on the row element) / `offsetWidth` (on the
 *  right element) / `scrollWidth` (on the content element) via
 *  `Object.defineProperty`. */
export function useFitsInline(): UseFitsInlineResult {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    if (!row || !content) return;

    const measure = () => {
      const cs = getComputedStyle(row);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      const parsedGap = parseFloat(cs.columnGap);
      const gap = Number.isNaN(parsedGap) ? GAP_FALLBACK_PX : parsedGap;
      const rightWidth = right?.offsetWidth ?? 0;
      const available =
        row.clientWidth - padLeft - padRight - rightWidth - (rightWidth > 0 ? gap : 0);
      setFits(content.scrollWidth <= available);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(row);
    ro.observe(content);
    if (right) ro.observe(right);
    return () => ro.disconnect();
  }, [row, right, content]);

  // Stable identities: `useState`'s setter is already referentially stable
  // across renders, so wrapping it doesn't cost a new function per render,
  // but `useCallback` documents the intent and keeps the return type an
  // explicit `RefCallback` rather than a bare state setter.
  const rowRef = useCallback((el: HTMLElement | null) => setRow(el), []);
  const rightRef = useCallback((el: HTMLElement | null) => setRight(el), []);
  const contentRef = useCallback((el: HTMLElement | null) => setContent(el), []);

  return { rowRef, rightRef, contentRef, fits };
}
