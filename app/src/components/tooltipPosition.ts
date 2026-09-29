import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";

export interface TooltipPosition {
  left: number;
  top: number;
  side: "left" | "right";
  vertical: "above" | "below";
}

export interface TooltipSize {
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

const GAP = 12;
const EDGE = 12;

function viewportSize(): ViewportSize {
  return {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

function positionAt(
  left: number,
  top: number,
  preferred?: Pick<TooltipPosition, "side" | "vertical">,
): TooltipPosition {
  const { width, height } = viewportSize();
  const boundedLeft = width > 0 ? Math.max(0, Math.min(left, width)) : left;
  const boundedTop = height > 0 ? Math.max(0, Math.min(top, height)) : top;
  return {
    left: boundedLeft,
    top: boundedTop,
    side: preferred?.side ?? (width > 0 && boundedLeft > width / 2 ? "left" : "right"),
    vertical: preferred?.vertical ?? (height > 0 && boundedTop > height / 2 ? "above" : "below"),
  };
}

/** Purely informative overlays follow the pointer in viewport coordinates. */
export function pointerTooltipPosition(clientX: number, clientY: number): TooltipPosition {
  return positionAt(clientX, clientY);
}

/** Keyboard users get the same overlay, anchored outside the focused host. */
export function focusedTooltipPosition(element: HTMLElement): TooltipPosition {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const { width, height } = viewportSize();
  const preferred = {
    side: width > 0 && centerX > width / 2 ? "left" as const : "right" as const,
    vertical: height > 0 && centerY > height / 2 ? "above" as const : "below" as const,
  };
  return positionAt(centerX, preferred.vertical === "above" ? rect.top : rect.bottom, preferred);
}

/** Resolve the overlay's top-left corner after its rendered size is known. */
export function resolvedTooltipPosition(
  anchor: TooltipPosition,
  size: TooltipSize,
  viewport = viewportSize(),
): Pick<TooltipPosition, "left" | "top"> {
  const desiredLeft = anchor.side === "left"
    ? anchor.left - size.width - GAP
    : anchor.left + GAP;
  const desiredTop = anchor.vertical === "above"
    ? anchor.top - size.height - GAP
    : anchor.top + GAP;
  const maxLeft = Math.max(EDGE, viewport.width - size.width - EDGE);
  const maxTop = Math.max(EDGE, viewport.height - size.height - EDGE);
  return {
    left: viewport.width > 0 ? Math.max(EDGE, Math.min(desiredLeft, maxLeft)) : desiredLeft,
    top: viewport.height > 0 ? Math.max(EDGE, Math.min(desiredTop, maxTop)) : desiredTop,
  };
}

/** Measure after render, then place the fixed overlay fully inside the viewport. */
export function useTooltipPosition(
  anchor: TooltipPosition | null,
  contentKey: string | number | null,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!anchor || !element) return;
    const rect = element.getBoundingClientRect();
    const resolved = resolvedTooltipPosition(anchor, rect);
    element.style.left = `${resolved.left}px`;
    element.style.top = `${resolved.top}px`;
  }, [anchor, contentKey]);
  return ref;
}

export function tooltipPositionStyle(position: TooltipPosition | null): CSSProperties | undefined {
  return position ? { left: position.left, top: position.top } : undefined;
}
