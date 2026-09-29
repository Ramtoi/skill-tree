import { ProgressBar } from "./ProgressBar";

export interface RowProgressProps {
  value?: number | null;
  accent?: string;
}

/** A 2px progress bar pinned to the bottom edge of a position:relative
 *  card / row being worked on. */
export function RowProgress({ value = null, accent }: RowProgressProps) {
  return (
    <div className="lds-row-progress">
      <ProgressBar value={value} height={2} accent={accent} />
    </div>
  );
}
