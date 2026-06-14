import { Fragment, isValidElement, type ReactNode } from "react";
import { Button } from "./Button";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";

export interface ScreenHeaderProps {
  /** Back-arrow button. Mutually exclusive with `leading` (back wins). */
  back?: { label: string; onClick: () => void };
  /** Identity glyph (project-dot, scope-glyph, section icon). */
  leading?: ReactNode;

  /** Main title — string or node. Rendered in sans. */
  title?: ReactNode;
  /** Alternative title for proper-noun identifiers — rendered in monospace. */
  nameMono?: string;
  /** Inline secondary identifiers after the title: KindTag, SourceChip, count tags. */
  meta?: ReactNode;

  /** Crumb tokens (mono dim line under title). Use <span className="path">…</span>
   *  (or the .crumb-path wrapper) for file paths to get reverse-ellipsis. */
  crumbs?: ReactNode[];
  /** Single meta line; composes after `crumbs` with a `·`, or renders alone. */
  subline?: ReactNode;

  /** One pill: <StatePill state="unsaved|readonly|saved|info"> */
  state?: ReactNode;

  /** Exactly ONE primary <Button variant="primary">. */
  primary?: ReactNode;
  /** Kebab-menu items — all other screen-level actions. */
  overflow?: OverflowMenuItem[];

  /** Row 2 — only renders when set. `{ left, right }` object or a raw node. */
  subheader?: { left?: ReactNode; right?: ReactNode } | ReactNode;

  className?: string;
}

/**
 * Single source of truth for the chrome above every main view. Row 1 is always
 * present; row 2 renders only when `subheader` is supplied. See COMPONENTS.md
 * § Screen header for the slot contract and per-screen mapping.
 */
export function ScreenHeader({
  back,
  leading,
  title,
  nameMono,
  meta,
  crumbs,
  subline,
  state,
  primary,
  overflow,
  subheader,
  className,
}: ScreenHeaderProps) {
  const hasCrumbs = Array.isArray(crumbs) && crumbs.length > 0;
  return (
    <>
      <div className={`main-header${className ? ` ${className}` : ""}`}>
        {back ? (
          <Button
            variant="ghost"
            icon="arrow-left"
            onClick={back.onClick}
            className="header-back"
            title={`Back to ${back.label}`}
          >
            {back.label}
          </Button>
        ) : (
          leading && <span className="header-leading">{leading}</span>
        )}

        <div className="main-title">
          <h2>
            {title && <span className="title-text">{title}</span>}
            {nameMono && <span className="title-mono">{nameMono}</span>}
            {meta}
            {state && <span className="title-state">{state}</span>}
          </h2>
          {hasCrumbs && (
            <div className="crumbs">
              {crumbs!.map((c, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="sep">/</span>}
                  {typeof c === "string" ? <span>{c}</span> : c}
                </Fragment>
              ))}
              {subline && (
                <>
                  <span className="sep">·</span>
                  <span>{subline}</span>
                </>
              )}
            </div>
          )}
          {!hasCrumbs && subline && (
            <div className="crumbs">
              <span>{subline}</span>
            </div>
          )}
        </div>

        <div className="main-header-right">
          {primary}
          {Array.isArray(overflow) && overflow.length > 0 && (
            <OverflowMenu items={overflow} />
          )}
        </div>
      </div>

      {subheader && (
        <div className="main-subheader">
          {isValidElement(subheader) ? (
            subheader
          ) : (
            <>
              <div className="main-subheader-left">
                {(subheader as { left?: ReactNode }).left}
              </div>
              {(subheader as { right?: ReactNode }).right && (
                <div className="main-subheader-right">
                  {(subheader as { right?: ReactNode }).right}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
