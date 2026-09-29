import { Fragment, isValidElement, useMemo, type ReactNode, type Ref } from "react";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import { BackButton } from "./BackButton";
import { Icon } from "./Icon";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";
import { isInPlace } from "@/lib/sections";
import { backReturnOptions, readBackTarget } from "@/lib/backTarget";

export interface ScreenHeaderProps {
  /** Back-chevron button, rendered ICON-ONLY inside the fixed identity column.
   *  `label` never paints — it is the accessible name / tooltip ("Back to X")
   *  and the parent is spelled out by `crumbs` + the navigator.
   *  Mutually exclusive with `leading` (back wins).
   *
   *  Optional now: when omitted, the primitive supplies the arrow itself for
   *  a screen shown IN PLACE inside another section's context (`isInPlace` —
   *  a referrer that names a different section). Pass this explicitly only
   *  when a screen wants its own label or target instead of the referrer's
   *  (SkillEditor, the bundle lens). */
  back?: { label: string; onClick: () => void };
  /** Identity glyph for screens whose identity is a THING (project-dot,
   *  HarnessGlyph logo, bundle emoji). For section screens use `icon`. */
  leading?: ReactNode;
  /** Section-icon slot: an ICONS key rendered in the standardized
   *  section-tinted chip with its live point lit — the header is the
   *  "you are here" surface, so it mirrors the rail's active glint.
   *  Precedence: `back` > `leading` > `icon`. */
  icon?: string;

  /** Main title — string or node. Rendered in sans. */
  title?: ReactNode;
  /** Alternative title for proper-noun identifiers — rendered in monospace.
   *  A node is allowed for an identifier that edits in place (`InlineName`);
   *  it inherits the mono title styling. */
  nameMono?: ReactNode;
  /** Inline secondary identifiers after the title: KindTag, SourceChip, count tags. */
  meta?: ReactNode;

  /** Crumb tokens (mono dim line under title). Use <span className="path">…</span>
   *  (or the .crumb-path wrapper) for file paths to get reverse-ellipsis.
   *  The line itself is ALWAYS reserved (16px) — leaving it empty costs the
   *  screen a blank line, never a 9px title jump. */
  crumbs?: ReactNode[];
  /** Single meta line; composes after `crumbs` with a `·`, or renders alone. */
  subline?: ReactNode;

  /** One pill: <StatePill state="unsaved|readonly|saved|info"> */
  state?: ReactNode;

  /** Exactly ONE primary <Button variant="primary">, always at the far right.
   *  Any soft/ghost companion in this slot must precede it. */
  primary?: ReactNode;
  /** At most ONE non-primary screen action, rendered beside `primary` in the
   *  header's action cluster. Never a `variant="primary"` button — the
   *  primary slot is the one primary. Use `overflow` for anything beyond
   *  these two. Added so an occasional action (the Usage screen's transcript
   *  scan) can stay visibly on the header even through the empty state,
   *  where `overflow` would hide it (design D14.5). */
  secondary?: ReactNode;
  /** Kebab-menu items — all other screen-level actions. */
  overflow?: OverflowMenuItem[];

  /** Row 2 — only renders when set. `{ left, right }` object or a raw node.
   *  `rowRef`/`rightRef` (object form only) forward onto `.main-subheader`
   *  and `.main-subheader-right` — a screen that needs to measure how much
   *  room the left cluster actually shares with the right one on one line
   *  (the Library's adaptive facet row, via `useFitsInline`) reads them
   *  without querying the DOM by class from outside the primitive. Measuring
   *  the ROW rather than `.main-subheader-left` itself matters: the left
   *  child's own box reshapes at the `@container appmain (max-width: 780px)`
   *  wrap breakpoint, which would otherwise read as "more room" exactly when
   *  the two clusters have in fact stopped sharing a line. */
  subheader?:
    | { left?: ReactNode; right?: ReactNode; rowRef?: Ref<HTMLDivElement>; rightRef?: Ref<HTMLDivElement> }
    | ReactNode;

  className?: string;
}

/**
 * Single source of truth for the chrome above every main view. Row 1 is always
 * present; row 2 renders only when `subheader` is supplied. See COMPONENTS.md
 * § Screen header for the slot contract and per-screen mapping.
 *
 * FIXED GEOMETRY (the whole point of the primitive): the identity column is
 * always 40px wide — spacer included — and the secondary crumb line is always
 * reserved, so the title's x/y origin is identical on every route. Navigation
 * is the app's most frequent event; a header that re-lays-out per screen makes
 * the eye re-find the title every single time.
 *
 * Router access is split into its own inner component rather than guarded
 * inline: `useLocation`/`useNavigate` THROW outside a `<Router>` (this
 * primitive's own tests render it bare), and conditionally calling a hook
 * inside one component trips `react-hooks/rules-of-hooks` even when the
 * condition can never change for a given mount. Branching on
 * `useInRouterContext()` — itself safe to call anywhere — to choose which
 * CHILD component renders keeps every hook call unconditional within its own
 * component while still skipping the router hooks entirely when there's no
 * router to read.
 */
export function ScreenHeader(props: ScreenHeaderProps) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <RoutedScreenHeader {...props} />
  ) : (
    <ScreenHeaderBody {...props} />
  );
}

/** Supplies the automatic back arrow (see `back` doc comment) from the
 *  current route, then defers to `ScreenHeaderBody` for the actual markup.
 *  An explicit `back` prop always wins over the derived one. */
function RoutedScreenHeader(props: ScreenHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const autoBack = useMemo(() => {
    if (!isInPlace(location.pathname, location.state)) return undefined;
    const referrer = readBackTarget(location.state);
    if (!referrer) return undefined;
    return {
      label: referrer.label,
      onClick: () => navigate(referrer.path, backReturnOptions(referrer)),
    };
  }, [location.pathname, location.state, navigate]);
  return <ScreenHeaderBody {...props} back={props.back ?? autoBack} />;
}

function ScreenHeaderBody({
  back,
  leading,
  icon,
  title,
  nameMono,
  meta,
  crumbs,
  subline,
  state,
  primary,
  secondary,
  overflow,
  subheader,
  className,
}: ScreenHeaderProps) {
  const hasCrumbs = Array.isArray(crumbs) && crumbs.length > 0;
  return (
    <>
      <div
        className={`main-header${className ? ` ${className}` : ""}`}
        data-testid="screen-header"
      >
        {/* Fixed 40px identity column — rendered even when empty so the title
            starts at the same x on every screen. */}
        <span className="header-identity" data-testid="screen-header-identity">
          {back ? (
            <BackButton
              onClick={back.onClick}
              className="header-back"
              title={`Back to ${back.label}`}
              data-testid="screen-header-back"
            />
          ) : leading ? (
            <span className="header-leading">{leading}</span>
          ) : icon ? (
            <span className="header-leading">
              <span
                className="header-glyph live-glint"
                data-live="true"
                data-testid="screen-header-glyph"
              >
                <Icon name={icon} size={15} />
              </span>
            </span>
          ) : null}
        </span>

        <div className="main-title">
          <h2>
            {title && <span className="title-text">{title}</span>}
            {nameMono && <span className="title-mono">{nameMono}</span>}
          </h2>
          {/* ALWAYS rendered, empty allowed: the second line is part of the
              header's fixed geometry, not a per-screen decoration. */}
          <div className="crumbs" data-testid="screen-header-crumbs">
            {hasCrumbs &&
              crumbs!.map((c, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="sep">/</span>}
                  {typeof c === "string" ? <span>{c}</span> : c}
                </Fragment>
              ))}
            {hasCrumbs && subline && (
              <>
                <span className="sep">·</span>
                {/* Shrinkable + ellipsized (see `.crumb-subline`) — composed
                    after a crumb trail it is the first thing to run out of
                    room, and a guillotined half-word informs nobody. [C5] */}
                <span className="crumb-subline">{subline}</span>
              </>
            )}
            {!hasCrumbs && subline && (
              /* A solo subline is PROSE, not a crumb trail — `.crumbs` is mono
                 because crumbs are identifiers. Sans + shrinkable + ellipsis,
                 and dropped entirely at compact widths where it would clip
                 mid-word. Pass a mono node if the subline is an identifier. */
              <span className="header-subline">{subline}</span>
            )}
          </div>
        </div>

        {/* Status cluster — a SIBLING of the title block, not a child of the
            24px h2. Inside the h2 these chips rode the title's own line, which
            the row's `align-items: center` centres on the 42px title BLOCK —
            leaving them ~9px above the optical centre the right-cluster buttons
            sit on, even though the eye reads them as one row of chips. As a
            direct child of `.main-header` they take the row's centre. */}
        {(meta || state) && (
          <span className="header-status">
            {meta && <span className="title-meta">{meta}</span>}
            {state && <span className="title-state">{state}</span>}
          </span>
        )}

        <div className="main-header-right">
          {Array.isArray(overflow) && overflow.length > 0 && (
            <OverflowMenu items={overflow} />
          )}
          {secondary}
          {primary}
        </div>
      </div>

      {subheader && (
        <div
          className="main-subheader"
          ref={
            isValidElement(subheader)
              ? undefined
              : (subheader as { rowRef?: Ref<HTMLDivElement> }).rowRef
          }
        >
          {isValidElement(subheader) ? (
            subheader
          ) : (
            <>
              <div className="main-subheader-left">
                {(subheader as { left?: ReactNode }).left}
              </div>
              {(subheader as { right?: ReactNode }).right && (
                <div
                  className="main-subheader-right"
                  ref={(subheader as { rightRef?: Ref<HTMLDivElement> }).rightRef}
                >
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
