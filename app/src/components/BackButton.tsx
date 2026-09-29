import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "./Button";
import { focusedTooltipPosition, tooltipPositionStyle, useTooltipPosition, type TooltipPosition } from "./tooltipPosition";

export type BackButtonProps = Omit<ButtonProps, "icon" | "variant" | "size">;

/** Shared return navigation. Keep destination labels and guards at the caller. */
export function BackButton({ className, title, children, onClick, ...props }: BackButtonProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const hovered = useRef(false);
  const [hint, setHint] = useState<{ position: TooltipPosition; label: string } | null>(null);
  const hintId = useId();
  const hintRef = useTooltipPosition(hint?.position ?? null, hint?.label ?? null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hide = useCallback(() => {
    clearTimer();
    setHint(null);
  }, [clearTimer]);
  const show = () => {
    clearTimer();
    const anchor = anchorRef.current;
    if (!anchor || props.disabled || props.busy) return;
    const label = title ?? anchor.textContent?.trim() ?? "Go back";
    setHint({ position: focusedTooltipPosition(anchor), label });
  };
  const leave = () => {
    hovered.current = false;
    clearTimer();
    if (!focused.current) timer.current = setTimeout(hide, 150);
  };

  useEffect(() => {
    hide();
    return clearTimer;
  }, [title, props.disabled, props.busy, hide, clearTimer]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (!hint || event.key !== "Escape") return;
      event.stopPropagation();
      hide();
    };
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("resize", hide);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && hintRef.current?.contains(event.target)) return;
      hide();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [hint, hide, hintRef]);

  return (
    // The wrapper observes its native button; it is not an additional control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      ref={anchorRef}
      className="back-button-anchor"
      onMouseEnter={() => { hovered.current = true; clearTimer(); timer.current = setTimeout(show, 300); }}
      onMouseLeave={leave}
      onFocus={() => { focused.current = true; show(); }}
      onBlur={() => { focused.current = false; if (!hovered.current) hide(); }}
    >
      <Button
        {...props}
        variant="ghost"
        icon="chevron-left"
        aria-label={props["aria-label"] ?? (!children ? title : undefined)}
        aria-describedby={hint ? hintId : props["aria-describedby"]}
        className={`back-button${className ? ` ${className}` : ""}`}
        onClick={(event) => { hide(); onClick?.(event); }}
      >
        {children}
      </Button>
      {hint && createPortal(
        // Pointer listeners keep this descriptive tooltip readable on hover.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          ref={hintRef}
          id={hintId}
          role="tooltip"
          className="back-button-tooltip"
          style={tooltipPositionStyle(hint.position)}
          onMouseEnter={() => { hovered.current = true; clearTimer(); }}
          onMouseLeave={leave}
        >
          {hint.label}
        </div>,
        document.body,
      )}
    </span>
  );
}
