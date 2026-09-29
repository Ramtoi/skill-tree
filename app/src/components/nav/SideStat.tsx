import type { ReactNode } from "react";
import type { SideStatProps } from "@/lib/navInsights";
import { FreshnessDot } from "@/components/FreshnessBadge";

// ─── T2 steady tiles (spec §5.2) ──────────────────────────────────────────────
// Exactly TWO tiles per group, always rendered — a tile never changes hue
// (R3). `navInsights` returns the pair as a real tuple, so a third tile is a
// type error at the source.

export type { SideStatProps };

function Tile({ label, value, valueState, sub, subTone, title }: SideStatProps) {
  const valueNode: ReactNode = valueState ? (
    <>
      <FreshnessDot state={valueState} size={6} />
      {value}
    </>
  ) : (
    value
  );
  return (
    <div className="side-stat side-plaque" title={title}>
      <span className="side-stat-label">{label}</span>
      <span className="side-stat-value">{valueNode}</span>
      <span className="side-stat-sub" data-tone={subTone}>
        {sub}
      </span>
    </div>
  );
}

export function SideStats({ tiles }: { tiles: [SideStatProps, SideStatProps] }) {
  return (
    <div className="side-stats">
      <Tile {...tiles[0]} />
      <Tile {...tiles[1]} />
    </div>
  );
}
