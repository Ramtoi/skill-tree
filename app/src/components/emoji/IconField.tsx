/**
 * A 40×40 icon trigger that opens the `EmojiPicker` in a shared `<Popover>`.
 * Owns only its own open/closed state — selection lives in the parent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "../Popover";
import { Icon } from "../Icon";
import { EmojiPicker } from "./EmojiPicker";

export interface IconFieldProps {
  value: string;
  onChange: (icon: string) => void;
  label?: string;
  id?: string;
}

export function IconField({ value, onChange, label = "Icon", id }: IconFieldProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // A pick, an Escape, or a Tab-exit all unmount the picker directly (`open`
  // flips straight to false) rather than through `Popover`'s own close path,
  // so THIS field owns returning focus to its trigger — otherwise it falls
  // to `document.body` and defeats the host Sheet's focus trap.
  const closePicker = useCallback(() => {
    setOpen(false);
    // eslint-disable-next-line no-restricted-syntax -- `triggerRef` is the always-mounted trigger button, never a node whose mount depends on this same `setOpen(false)`; the rAF only sequences after the picker's own unmount.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  // Modal's own backdrop closes the WHOLE sheet on `mousedown`. While the
  // picker is open, a click meant only to dismiss it (it visually overlaps
  // the backdrop) would otherwise also discard the sheet's typed name —
  // intercept in the capture phase, before the backdrop's own bubble-phase
  // `onMouseDown` ever runs, and close just the picker instead.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.classList.contains("modal-backdrop")) {
        e.stopPropagation();
        closePicker();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, closePicker]);

  return (
    <div className="icon-field">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="icon-field-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value}. Change`}
        title="Change icon"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="icon-field-glyph">{value}</span>
        <span className="icon-field-caret" aria-hidden="true">
          <Icon name="chevron-down" size={10} />
        </span>
      </button>
      <Popover
        open={open}
        onClose={closePicker}
        anchorRef={triggerRef}
        align="left"
        width={324}
        label="Pick an icon"
        className="emoji-popover"
      >
        <EmojiPicker
          value={value}
          onPick={(emoji) => {
            onChange(emoji);
            closePicker();
          }}
          onClose={closePicker}
        />
      </Popover>
    </div>
  );
}
