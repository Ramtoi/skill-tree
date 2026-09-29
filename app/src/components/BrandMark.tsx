import type { ReactNode } from "react";

interface Props {
  /** Rendered box in px (the mark is square). */
  size?: number;
  /** Stroke weight for the shield outline and the branch. Scaled with `size`
   *  by the caller when a heavier mark is wanted at small sizes. */
  strokeWidth?: number;
  /** Radius of the two branch-tip nodes. */
  dotR?: number;
  className?: string;
}

/**
 * The product mark — shield + branch + gem apex. This is the SAME geometry the
 * landing page header (`website/src/components/Mark.astro`), the site favicon,
 * and the packaged app icon draw, so the app's own chrome is not the one
 * surface still showing a placeholder.
 *
 * Colors come from the app tokens rather than the site's literals: `--fg-mute`
 * for the shield/nodes, `--anchor-2` for the branch and gem. The mark is
 * identity, so it carries the brand accent by right — it is not an "active"
 * signal (COMPONENTS.md §Accents, identity channel).
 */
export function BrandMark({
  size = 22,
  strokeWidth = 1.5,
  dotR = 1.7,
  className,
}: Props): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 1.8 L21 6 V13 C21 17.5, 17 20.8, 12 22.4 C7 20.8, 3 17.5, 3 13 V6 Z"
        fill="color-mix(in oklab, var(--anchor) 8%, transparent)"
        stroke="var(--fg-mute)"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d="M12 7.2 L8 16 M12 7.2 L16 16"
        stroke="color-mix(in oklab, var(--anchor-2) 70%, transparent)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="8" cy="16" r={dotR} fill="var(--fg-mute)" />
      <circle cx="16" cy="16" r={dotR} fill="var(--fg-mute)" />
      <path d="M12 4.6 L14 7 L12 9.4 L10 7 Z" fill="var(--anchor-2)" />
    </svg>
  );
}
