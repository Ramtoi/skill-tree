import {
  CLOUD_DESCRIPTION_MAX,
  descriptionLengthState,
} from "@/lib/descriptionLimits";

interface Props {
  value: string;
  /** Count only, no note, no tier tint — for a description the user cannot edit. */
  muted?: boolean;
}

/** Passive chars-vs-limit readout for a skill description. Presentational only:
 *  no IPC, no store, and it never blocks a save. */
export function DescriptionMeter({ value, muted = false }: Props) {
  const { tier, note } = descriptionLengthState(value.length);
  return (
    <span className="desc-meter" data-tier={muted ? "ok" : tier}>
      <span className="desc-meter-count">
        {value.length} / {CLOUD_DESCRIPTION_MAX}
      </span>
      {!muted && note && <span className="desc-meter-note">{note}</span>}
    </span>
  );
}

/** Class a caller puts on the `Field` so the control picks up the tier tint.
 *  Deliberately not `.field-invalid` — that carries hard-invalid semantics. */
export function descriptionFieldClass(value: string): string {
  const { tier } = descriptionLengthState(value.length);
  if (tier === "spec") return "field-desc-over";
  if (tier === "ok") return "";
  return "field-desc-warn";
}
