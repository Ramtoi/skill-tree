import { useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

const HOLD_MS = 250;
const SLOP_PX = 6;
const CONTROLS = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"]:not(.resource-row), [role="combobox"], .resource-detail, .playbook-move-controls';

type Point = { x: number; y: number };

/** Pointer pickup without stealing short clicks, text selection, or controls. */
export function useHoldDrag<T>(options: {
  scrollContainer?: (owner: HTMLElement) => HTMLElement | null;
  onStart: (item: T) => void;
  onMove: (item: T, point: Point) => void;
  onEnd: (item: T, point: Point | null) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, item: T) {
    suppressClick.current = false;
    if (event.button !== 0 || event.isPrimary === false || (event.target as Element).closest(CONTROLS)) return;
    cleanup.current?.();
    const owner = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let point = start;
    let active = false;
    let moved = false;
    let frame = 0;
    let finished = false;
    const scroller = latest.current.scrollContainer ? latest.current.scrollContainer(owner) : owner.closest<HTMLElement>(".main-body");

    function tick() {
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
          const delta = point.y < bounds.top + 32 ? -8 : point.y > bounds.bottom - 32 ? 8 : 0;
          if (delta) { scroller.scrollTop += delta; latest.current.onMove(item, point); }
        }
      }
      frame = requestAnimationFrame(tick);
    }
    const timer = window.setTimeout(() => {
      active = true;
      suppressClick.current = true;
      owner.setPointerCapture?.(pointerId);
      window.getSelection()?.removeAllRanges();
      latest.current.onStart(item);
      frame = requestAnimationFrame(tick);
    }, HOLD_MS);

    function dispose() {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      owner.removeEventListener("lostpointercapture", cancel);
      if (owner.hasPointerCapture?.(pointerId)) owner.releasePointerCapture(pointerId);
      cleanup.current = null;
    }
    function finish(commit: boolean) {
      if (finished) return;
      finished = true;
      dispose();
      if (active) latest.current.onEnd(item, commit && moved ? point : null);
    }
    function move(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      point = { x: e.clientX, y: e.clientY };
      if (!active) {
        if (Math.hypot(point.x - start.x, point.y - start.y) > SLOP_PX) finish(false);
        return;
      }
      e.preventDefault();
      moved = true;
      latest.current.onMove(item, point);
    }
    function up(e: PointerEvent) { if (e.pointerId === pointerId) { point = { x: e.clientX, y: e.clientY }; finish(true); } }
    function cancel() { finish(false); }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    }
    cleanup.current = dispose;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    owner.addEventListener("lostpointercapture", cancel);
  }

  function onClickCapture(event: MouseEvent) {
    if (suppressClick.current && event.detail > 0) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }
  return { onPointerDown, onClickCapture };
}
