import type { KeyboardEvent, MouseEvent, SyntheticEvent } from "react";

/** Swallow an event so it does not reach an ancestor's onClick. Named, not
 *  inline, so the a11y source-scan (`src/test/clickableA11y.test.ts`) can
 *  recognise a pure click sink via `onClick={stopEvent}`. */
export function stopEvent(e: Pick<SyntheticEvent, "stopPropagation">): void {
  e.stopPropagation();
}

/** Props for a layout wrapper whose only job is to stop clicks reaching a
 *  parent card — e.g. an action cluster nested inside a clickable row. */
export function clickSink(): { role: "presentation"; onClick: typeof stopEvent } {
  return { role: "presentation", onClick: stopEvent };
}

export interface PressableOptions {
  /** No tab stop, no activation — mirrors a disabled control. */
  disabled?: boolean;
  /** Also stop the key/click event from reaching an ancestor handler
   *  (roving-tabIndex containers that also bind Enter, for example). */
  isolate?: boolean;
}

/** Make a non-`<button>` element behave like a button for both mouse and
 *  keyboard activation. Returns `{}` when `onPress` is undefined, so an
 *  optional-onClick component (e.g. `BundleChip`) gains no bogus
 *  `role="button"` when it isn't actually clickable. */
export function pressable(
  onPress: (() => void) | undefined,
  opts: PressableOptions = {},
): Record<string, unknown> {
  if (!onPress) return {};
  const { disabled = false, isolate = false } = opts;

  const onClick = (e: MouseEvent) => {
    if (isolate) e.stopPropagation();
    if (disabled) return;
    onPress();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (isolate) e.stopPropagation();
    if (disabled) return;
    onPress();
  };

  return {
    role: "button",
    tabIndex: disabled ? -1 : 0,
    onClick,
    onKeyDown,
  };
}
