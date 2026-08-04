import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/store";
import { Button } from "./Button";
import { Kbd } from "./Kbd";
import { TOUR, resolveTourHint, type TourHint } from "@/lib/tips";

const CARD_WIDTH = 320;
const GAP = 12; // px between anchor and card
const MARGIN = 8; // viewport clamp margin

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Place the card adjacent to the anchor (right → left → below → above),
 *  clamped inside the viewport. */
function placeCard(
  anchor: Rect,
  cardW: number,
  cardH: number,
  vw: number,
  vh: number,
): { top: number; left: number } {
  const clampTop = (t: number) =>
    Math.max(MARGIN, Math.min(t, vh - cardH - MARGIN));
  const clampLeft = (l: number) =>
    Math.max(MARGIN, Math.min(l, vw - cardW - MARGIN));

  // Right of the anchor.
  if (anchor.left + anchor.width + GAP + cardW <= vw - MARGIN) {
    return { top: clampTop(anchor.top), left: anchor.left + anchor.width + GAP };
  }
  // Left of the anchor.
  if (anchor.left - GAP - cardW >= MARGIN) {
    return { top: clampTop(anchor.top), left: anchor.left - GAP - cardW };
  }
  // Below the anchor.
  if (anchor.top + anchor.height + GAP + cardH <= vh - MARGIN) {
    return { top: anchor.top + anchor.height + GAP, left: clampLeft(anchor.left) };
  }
  // Above the anchor.
  return { top: clampTop(anchor.top - GAP - cardH), left: clampLeft(anchor.left) };
}

/** True when `el` is a natively-activatable control — Enter should activate it
 *  rather than be captured as the tour's "next". */
function isInteractive(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "BUTTON" ||
    tag === "A" ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable ||
    el.getAttribute("role") === "button"
  );
}

/** Render one keymap-sourced hint as a sequence of <Kbd> tokens. */
function HintKbd({ hint }: { hint: TourHint }) {
  const str = resolveTourHint(hint);
  if (!str) return null;
  return (
    <span className="tips-hint">
      {str.split(" ").map((t, i) => (
        <Kbd key={i}>{t}</Kbd>
      ))}
    </span>
  );
}

/**
 * First-run tips tour (design-locked). A non-modal, portal-rendered coach-mark
 * layer: the page stays visible and interactive. Each step targets a
 * `[data-tour]` anchor, ringed in brand violet, with a floating card placed
 * beside it (centered when the anchor is missing/hidden). Keyboard: Esc skips
 * (persists done), →/Enter next, ← back — all captured so they never leak into
 * the global single-key / chord handlers.
 */
export function TipsTour() {
  const open = useAppStore((s) => s.tipsOpen);
  const step = useAppStore((s) => s.tipsStep);
  const closeTips = useAppStore((s) => s.closeTips);
  const nextTip = useAppStore((s) => s.nextTip);
  const prevTip = useAppStore((s) => s.prevTip);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [ring, setRing] = useState<Rect | null>(null);

  const current = TOUR[step];
  const isLast = step === TOUR.length - 1;
  const isFirst = step === 0;

  const goNext = useCallback(() => {
    if (isLast) closeTips(true);
    else nextTip();
  }, [isLast, closeTips, nextTip]);

  // Position the card + ring against the current anchor. Recomputes on step
  // change, resize, and scroll. Layout effect so the card is measured before
  // paint (no first-frame flash at the wrong spot).
  useLayoutEffect(() => {
    if (!open || !current) return;
    function recompute() {
      const card = cardRef.current;
      const cw = card?.offsetWidth || CARD_WIDTH;
      const ch = card?.offsetHeight || 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const anchor = document.querySelector<HTMLElement>(
        `[data-tour="${current.id}"]`,
      );
      const r = anchor?.getBoundingClientRect();
      if (!anchor || !r || (r.width === 0 && r.height === 0)) {
        // Missing / hidden anchor → center the card, no ring.
        setRing(null);
        setPos({
          top: Math.max(MARGIN, (vh - ch) / 2),
          left: Math.max(MARGIN, (vw - cw) / 2),
        });
        return;
      }
      setRing({ top: r.top, left: r.left, width: r.width, height: r.height });
      setPos(placeCard({ top: r.top, left: r.left, width: r.width, height: r.height }, cw, ch, vw, vh));
    }
    // Collapse a burst of scroll/resize events into ONE measurement per frame
    // (a pending-frame guard); the step-change recompute stays synchronous so the
    // card is placed before paint.
    let frame = 0;
    function scheduleRecompute() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    }
    recompute();
    window.addEventListener("resize", scheduleRecompute);
    window.addEventListener("scroll", scheduleRecompute, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleRecompute);
      window.removeEventListener("scroll", scheduleRecompute, true);
    };
  }, [open, step, current]);

  // Keyboard, captured at the window so it can never leak into the global
  // single-key handler (App.tsx) or the chord dispatcher (useChords) while the
  // tour is open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave ⌘K etc. alone
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeTips(true);
      } else if (e.key === "Enter") {
        // Enter advances the tour — EXCEPT when a real interactive element (the
        // Back/Skip/Next buttons, a link, an input) is focused/targeted: let it
        // activate natively instead of hijacking to "next". Arrow keys are
        // unambiguous and always drive the tour.
        if (isInteractive(e.target) || isInteractive(document.activeElement)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        goNext();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        prevTip();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, goNext, prevTip, closeTips]);

  if (!open || !current) return null;

  return createPortal(
    <div className="tips-overlay" aria-hidden={false}>
      {ring && (
        <div
          className="tips-ring"
          style={{
            top: ring.top,
            left: ring.left,
            width: ring.width,
            height: ring.height,
          }}
        />
      )}
      <div
        ref={cardRef}
        className="tips-card"
        role="dialog"
        aria-label={current.title}
        data-tour-card
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      >
        <div className="tips-card-head">
          <span className="tips-step-count">
            {step + 1} / {TOUR.length}
          </span>
          <button
            type="button"
            className="tips-close"
            aria-label="Close tour"
            title="Close tour"
            onClick={() => closeTips(true)}
          >
            ✕
          </button>
        </div>
        <h3 className="tips-title">{current.title}</h3>
        <p className="tips-body">{current.body}</p>
        {current.hints && current.hints.length > 0 && (
          <div className="tips-hints">
            {current.hints.map((h, i) => (
              <HintKbd key={i} hint={h} />
            ))}
          </div>
        )}
        <div className="tips-dots" aria-hidden="true">
          {TOUR.map((s, i) => (
            <Fragment key={s.id}>
              <span className="tips-dot" data-active={i === step || undefined} />
            </Fragment>
          ))}
        </div>
        <div className="tips-foot">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => closeTips(true)}
          >
            Skip tour
          </Button>
          <div className="tips-foot-nav">
            <Button
              variant="ghost"
              size="sm"
              onClick={prevTip}
              disabled={isFirst}
            >
              Back
            </Button>
            <Button variant="primary" size="sm" onClick={goNext}>
              {isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
