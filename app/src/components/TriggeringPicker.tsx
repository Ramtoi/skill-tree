import { Icon } from "./Icon";
import {
  INVOCATION_CONSEQUENCE,
  INVOCATION_HARNESS_HINT,
  INVOCATION_LABEL,
  isConflicted,
  effectiveLibraryMode,
  type InvocationMode,
} from "@/lib/invocation";

const MODES: InvocationMode[] = ["auto", "user-only", "model-only"];

export interface TriggeringPickerProps {
  /** Current registry mirror value (undefined / "auto" → Auto). */
  invocation?: string;
  /** Fired with the chosen settable mode. Picking any mode repairs a
   *  `conflicted` state. */
  onPick: (mode: InvocationMode) => void;
  /** Disable the whole control (external skills / MCP servers) with a reason. */
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
}

/**
 * The SkillEditor "Triggering" picker — a sibling of the Reach (scope) field.
 * Three radio-style options, each with a one-line consequence, plus the
 * harness-portability hint. Composes Icon + native inputs; no new one-off
 * styled primitives. Saving routes through the caller's set-meta path.
 */
export function TriggeringPicker({
  invocation,
  onPick,
  disabled,
  disabledReason,
  busy,
}: TriggeringPickerProps) {
  const current = effectiveLibraryMode(invocation);
  const conflicted = isConflicted(invocation);

  return (
    <div className="side-panel-block triggering-block">
      <h4>Triggering</h4>
      {conflicted && (
        <p className="triggering-conflict" role="status">
          <Icon name="warning" size={12} />
          <span>
            Both invocation flags are set in the frontmatter — a contradiction.
            Pick any mode to repair it.
          </span>
        </p>
      )}
      <div
        className="triggering-options"
        role="radiogroup"
        aria-label="Triggering"
        aria-disabled={disabled || undefined}
      >
        {MODES.map((mode) => {
          const active = !conflicted && current === mode;
          return (
            <label
              key={mode}
              className="triggering-option"
              data-active={active || undefined}
              data-disabled={disabled || undefined}
            >
              <input
                type="radio"
                name="triggering"
                value={mode}
                checked={active}
                disabled={disabled || busy}
                onChange={() => onPick(mode)}
              />
              <span className="triggering-option-body">
                <span className="triggering-option-label">
                  {INVOCATION_LABEL[mode]}
                </span>
                <span className="triggering-option-consequence">
                  {INVOCATION_CONSEQUENCE[mode]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {disabled && disabledReason ? (
        <p className="triggering-locked" role="note">
          <Icon name="link" size={11} />
          <span>{disabledReason}</span>
        </p>
      ) : (
        <p className="triggering-harness-hint">{INVOCATION_HARNESS_HINT}</p>
      )}
    </div>
  );
}
