import { ChipRadios } from "./ChipRadios";
import { Icon } from "./Icon";
import {
  INVOCATION_CONSEQUENCE,
  INVOCATION_LABEL,
  isConflicted,
  effectiveLibraryMode,
  type InvocationMode,
  type InvocationSettled,
} from "@/lib/invocation";

const MODES: InvocationMode[] = ["auto", "user-only", "model-only"];

export interface TriggeringPickerProps {
  /** Current registry mirror value (undefined / "auto" → Auto). */
  invocation?: string;
  /** Fired with the chosen settable mode. Picking any mode repairs a
   *  `conflicted` state. */
  onPick: (mode: InvocationMode) => void;
  /** Preview a mode's target outcomes without changing the selected mode. */
  onPreview?: (mode: InvocationMode | null) => void;
  /** Disable the whole control (external skills / MCP servers) with a reason. */
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean | InvocationMode;
  settled?: InvocationSettled;
}

/** Mode intent stays in chip tooltips; target cards describe actual behavior. */
export function TriggeringPicker({
  invocation,
  onPick,
  onPreview,
  disabled,
  disabledReason,
  busy,
  settled,
}: TriggeringPickerProps) {
  const current = effectiveLibraryMode(invocation);
  const conflicted = isConflicted(invocation);

  function pick(mode: InvocationMode) {
    onPreview?.(null);
    onPick(mode);
  }

  return (
    <div className="triggering-block">
      {conflicted && (
        <p className="triggering-conflict" role="status">
          <Icon name="warning" size={12} />
          <span>
            Both invocation flags are set in the frontmatter — a contradiction.
            Pick any mode to repair it.
          </span>
        </p>
      )}
      <div className="triggering-picker-row">
        <ChipRadios
          name="triggering"
          label="Triggering"
          value={conflicted ? null : current}
          options={MODES.map((mode) => ({
            value: mode,
            label: INVOCATION_LABEL[mode],
            title: INVOCATION_CONSEQUENCE[mode],
          }))}
          onChange={pick}
          onPreview={onPreview}
          disabled={disabled}
          busy={busy}
        />
        {settled && (
          <span className="triggering-settled equip-settled" role="status">
            {settled}
          </span>
        )}
      </div>
      {disabled && disabledReason ? (
        <p className="triggering-locked" role="note">
          <Icon name="link" size={11} />
          <span>{disabledReason}</span>
        </p>
      ) : null}
    </div>
  );
}
