import { useEffect, useRef, useState } from "react";
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

const MODES: InvocationMode[] = ["auto", "user-only", "model-only"];

export interface SkillInvocationOverrideProps {
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
  libraryInvocation,
  override,
  scope,
  onPick,
}: SkillInvocationOverrideProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gated = scope === "global";
  const libraryMode = effectiveLibraryMode(libraryInvocation);
  const hasOverride = override !== undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(choice: OverrideChoice) {
    setOpen(false);
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
        type="button"
        className="invocation-override-trigger"
        data-override={hasOverride || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Set per-project triggering"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="command" size={11} />
        <span className="invocation-override-label">{triggerLabel}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <div
          className="invocation-override-menu"
          role="menu"
          aria-label="Triggering override"
          onClick={(e) => e.stopPropagation()}
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
                onClick={() => choose("inherit")}
              >
                <span className="invocation-override-check">
                  {!hasOverride && <Icon name="check" size={12} />}
                </span>
                <span className="invocation-override-item-body">
                  <span>Inherit</span>
                  <span className="invocation-override-item-sub">
                    library: {INVOCATION_LABEL[libraryMode]}
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
        </div>
      )}
    </div>
  );
}
