import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  INVOCATION_CONSEQUENCE,
  INVOCATION_GLOBAL_OVERRIDE_REASON,
  INVOCATION_LABEL,
  effectiveLibraryMode,
  type InvocationMode,
  type OverrideChoice,
} from "@/lib/invocation";
import type { SkillScope } from "@/types";
import { stopEvent } from "@/lib/pressable";
import { useInvocationStatus } from "@/hooks/useInvocationStatus";
import { InvocationOutcomes } from "@/components/InvocationOutcomes";

const MODES: InvocationMode[] = ["auto", "user-only", "model-only"];

export interface SkillInvocationOverrideProps {
	/** Registry key used by the read-only native outcome query. */
	skillName: string;
	projectName: string;
  /** The skill's library-level mode (its own default). */
  libraryInvocation?: string;
  /** The active per-project override, if any. Undefined = inheriting. */
  override?: "auto" | "user-only" | "model-only";
  scope: SkillScope;
  /** Fired with the chosen mode (or "inherit" to clear) + the previous
   *  override value (undefined when none) so the caller can build undo. */
  onPick: (
    choice: OverrideChoice,
    previous: "auto" | "user-only" | "model-only" | undefined,
  ) => void;
}

/**
 * Per-project triggering override for a ProjectWorkspace skill card. A compact
 * popover (Inherit / Auto / User-only / Model-only). For `scope: global` skills
 * the options are disabled and the precedence explanation is shown instead of
 * failing. Active overrides mark the trigger with a visible indicator.
 */
export function SkillInvocationOverride({
	skillName,
	projectName,
	libraryInvocation,
  override,
  scope,
  onPick,
}: SkillInvocationOverrideProps) {
  const [open, setOpen] = useState(false);
  const [previewChoice, setPreviewChoice] = useState<OverrideChoice | null>(null);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 400 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The trigger is hover-revealed inside `.card-actions` (COMPONENTS.md §Skill
  // card) — closing the menu without returning focus here drops a keyboard
  // user to `body`, `:focus-within` ends, and the trigger fades out from
  // under them (REVIEW-A / GRILL #7).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const gated = scope === "global";
  const libraryMode = effectiveLibraryMode(libraryInvocation);
	const inheritedMode = libraryInvocation === "conflicted" ? "conflicted" : libraryMode;
	const hasOverride = override !== undefined;
	const invocationStatus = useInvocationStatus(skillName, projectName, open);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const container = triggerRef.current.closest(".workspace-main")?.getBoundingClientRect();
    const lowerEdge = Math.min(window.innerHeight - 28, container?.bottom ?? window.innerHeight);
    const upperEdge = Math.max(56, container?.top ?? 0);
    const below = lowerEdge - anchor.bottom - 12;
    const above = anchor.top - upperEdge - 12;
    const opensAbove = below < 300 && above > below;
    setPlacement({ above: opensAbove, maxHeight: Math.max(120, opensAbove ? above : below) });
  }, [open]);

  function close() {
    setOpen(false);
    setPreviewChoice(null);
    triggerRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The user is deliberately clicking elsewhere — stealing focus back to
      // the trigger here would fight them, so this branch stays `setOpen`,
      // never `close()`.
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    const scrollContainer = triggerRef.current?.closest(".workspace-main");
    const onViewportChange = () => {
      if (wrapRef.current?.contains(document.activeElement)) close();
      else { setOpen(false); setPreviewChoice(null); }
    };
    // Focusing the trigger can queue a scroll before the menu opens; the
    // trigger's own rect (not `scrollContainer.scrollTop`, finding B: scroll
    // anchoring changes scrollTop under `.workspace-main` while the trigger
    // stays put) is the only reliable "did anything that matters actually
    // move" signal — mirrors `Popover.tsx`'s and `OverflowMenu.tsx`'s guard.
    const openedAnchor = triggerRef.current?.getBoundingClientRect();
    const onScroll = () => {
      const current = triggerRef.current?.getBoundingClientRect();
      if (current && openedAnchor && current.top === openedAnchor.top && current.left === openedAnchor.left) return;
      onViewportChange();
    };
    scrollContainer?.addEventListener("scroll", onScroll);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      scrollContainer?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open]);

  function choose(choice: OverrideChoice) {
    close();
    // No-op if the choice matches the current state.
    const currentChoice: OverrideChoice = hasOverride
      ? (override as InvocationMode)
      : "inherit";
    if (choice === currentChoice) return;
    onPick(choice, override);
  }

  const triggerLabel = hasOverride
    ? INVOCATION_LABEL[override as InvocationMode]
    : "Inherit";

  return (
    <div className="invocation-override" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="invocation-override-trigger"
        data-testid="skill-card-invocation"
        data-override={hasOverride || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Set per-project triggering"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewChoice(null);
          setOpen(!open);
        }}
      >
        <Icon name="command" size={11} />
        <span className="invocation-override-label">{triggerLabel}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- onClick only stops a click inside the menu from also closing it via an ancestor handler; role="menu" already carries the real interaction semantics (each menuitemradio below is independently keyboard-operable).
        <div
          className="invocation-override-menu"
          role="menu"
          aria-label="Triggering override"
          data-placement={placement.above ? "above" : "below"}
          style={{ maxHeight: placement.maxHeight, overflowY: "auto" }}
          onClick={stopEvent}
		  onMouseLeave={() => setPreviewChoice(null)}
		  onBlur={(event) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewChoice(null);
		  }}
        >
          {gated ? (
            <p className="invocation-override-gated" role="note">
              <Icon name="warning" size={12} />
              <span>{INVOCATION_GLOBAL_OVERRIDE_REASON}</span>
            </p>
          ) : (
            <>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!hasOverride}
                className="invocation-override-item"
                data-active={!hasOverride || undefined}
                onMouseEnter={() => setPreviewChoice("inherit")}
                onFocus={() => setPreviewChoice("inherit")}
                onClick={() => choose("inherit")}
              >
                <span className="invocation-override-check">
                  {!hasOverride && <Icon name="check" size={12} />}
                </span>
                <span className="invocation-override-item-body">
                  <span>Inherit</span>
                  <span className="invocation-override-item-sub">
                    library: {inheritedMode === "conflicted" ? "conflicted" : INVOCATION_LABEL[libraryMode]}
                  </span>
                </span>
              </button>
              {MODES.map((mode) => {
                const active = hasOverride && override === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className="invocation-override-item"
                    data-active={active || undefined}
                    onMouseEnter={() => setPreviewChoice(mode)}
                    onFocus={() => setPreviewChoice(mode)}
                    onClick={() => choose(mode)}
                  >
                    <span className="invocation-override-check">
                      {active && <Icon name="check" size={12} />}
                    </span>
                    <span className="invocation-override-item-body">
                      <span>{INVOCATION_LABEL[mode]}</span>
                      <span className="invocation-override-item-sub">
                        {INVOCATION_CONSEQUENCE[mode]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
			<InvocationOutcomes
				status={invocationStatus.data}
				mode={previewChoice === "inherit" ? inheritedMode : previewChoice ?? override ?? inheritedMode}
				isLoading={invocationStatus.isLoading}
				hasError={invocationStatus.isError}
			/>
        </div>
      )}
    </div>
  );
}
