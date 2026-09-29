import { type CSSProperties } from "react";

export interface SkeletonLineProps {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

/** Shimmer placeholder line. */
export function SkeletonLine({ width = "100%", height = 10, style }: SkeletonLineProps) {
  return <span className="lds-skel" style={{ width, height, ...style }} />;
}

export type SkeletonDensity = "compact" | "default" | "cozy";

/** A single list-row placeholder. Use ~12 for a list view's first paint. */
export function SkeletonRow({ density = "default" }: { density?: SkeletonDensity }) {
  const rowH = density === "compact" ? 32 : density === "cozy" ? 44 : 38;
  return (
    <div className="lds-skel-row" style={{ height: rowH }}>
      <SkeletonLine width={24} height={14} style={{ borderRadius: 3, flex: "0 0 auto" }} />
      <SkeletonLine width="18%" height={11} />
      <SkeletonLine width={42} height={14} style={{ borderRadius: 999 }} />
      <SkeletonLine width="52%" height={9} style={{ opacity: 0.7 }} />
      <SkeletonLine width={28} height={9} style={{ opacity: 0.5, marginLeft: "auto" }} />
    </div>
  );
}

/** A card placeholder for grid first-paint. */
export function SkeletonCard() {
  return (
    <div className="lds-skel-card">
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
        <SkeletonLine width={24} height={14} style={{ borderRadius: 3 }} />
        <SkeletonLine width="58%" height={11} />
        <SkeletonLine width={36} height={14} style={{ borderRadius: 999, marginLeft: "auto" }} />
      </div>
      <SkeletonLine width="92%" height={9} style={{ opacity: 0.7, marginBottom: 6 }} />
      <SkeletonLine width="68%" height={9} style={{ opacity: 0.5 }} />
    </div>
  );
}
