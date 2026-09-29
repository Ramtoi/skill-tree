import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { NavigateFunction, NavigateOptions } from "react-router-dom";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";
import { Icon } from "@/components/Icon";
import type { Registry } from "@/types";
import type { HarnessStatus } from "@/store";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

// ─── Pin identity (shared by NavPanel's persistence layer and every body
// module that renders a pinnable row) ─────────────────────────────────────────

/** The only two kinds that can be pinned. Everything else in the panel either
 *  has no per-item route or is already one keystroke away. */
export const PIN_KINDS = ["project", "bundle"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

export const pinKey = (kind: PinKind, id: string) => `${kind}:${id}`;

/** Bundle menu actions are shared by primary and expanded navigator rows. */
export function bundleRenameMenu(
  name: string,
  navigate: NavigateFunction,
  options?: NavigateOptions,
): OverflowMenuItem[] {
  return [{
    icon: "edit",
    label: "Rename bundle…",
    restoreFocus: false,
    onClick: () => navigate(`/bundle/${encodeURIComponent(name)}?rename=1`, options),
  }];
}

// ─── Row primitives (moved verbatim from NavPanel.tsx — the second consumer
// now exists, COMPONENTS.md's own promotion rule) — plus the spec §5.1
// additions: `hint`/`hintTone`/`detail`/`nested`. ─────────────────────────────

export interface SideRowProps {
  leading?: ReactNode;
  /** Right-aligned status mark (a harness's installed/on state dot). Sits after
   *  the name so the leading box can carry identity instead. */
  trailing?: ReactNode;
  name: string;
  /** Right-aligned number. ONE meaning per section; `countTitle` states it. */
  count?: number;
  countTitle?: string;
  /** Small trailing label (hook event, cloud target kind, or an insight mark
   *  from `navInsights`'s `*RowMark` helpers). */
  hint?: string;
  /** Tone of the hint word. `severity` is the ONE amber use (Codex trust
   *  auto-grant on a project-permissions row). */
  hintTone?: "warn" | "error" | "severity";
  active?: boolean;
  onClick: () => void;
  title?: string;
  /** Renders the pin as a SIBLING button (never nested inside the row button —
   *  that is invalid HTML and unreachable by keyboard). */
  pin?: { pinned: boolean; onToggle: () => void };
  menu?: OverflowMenuItem[];
  /** Quiet "go do a thing" row (info blocks + empty-state CTAs). */
  action?: boolean;
  /** Present but unavailable (a harness this machine has not installed). Two
   *  hollow dots alone cannot carry "off" vs "absent". */
  dim?: boolean;
  /** "You are here": the row's destination IS the current route, so it is a
   *  MARKER, not a control. Rendered as a non-interactive element — a button
   *  that cannot go anywhere is a dead affordance. */
  here?: boolean;
  /** Renders the block UNDER the row; the row gets `data-expanded`. Callers
   *  pass this only for the `aria-current` row (spec §5.1/§5.4). */
  detail?: ReactNode;
  /** Nested rows inside a detail block: indented, no pin, may be `aria-current`
   *  when `currentPath === href`. */
  nested?: boolean;
}

export function SideRow({
  leading,
  trailing,
  name,
  count,
  countTitle,
  hint,
  hintTone,
  active,
  onClick,
  title,
  pin,
  menu,
  action,
  dim,
  here,
  detail,
  nested,
}: SideRowProps) {
  // The lists are uncapped, so the row you are ON can easily sit below the
  // fold — the panel would then look like it had lost your place. `nearest`
  // scrolls only when it has to, so an already-visible row never jumps.
  // (jsdom has no `scrollIntoView`; the optional call keeps tests honest.)
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // The leading box is reserved unconditionally so a glyphless row's label
  // lines up with a glyph row's label (P2).
  const inner = (
    <>
      <span className="side-item-lead">{leading}</span>
      <span className="name">{name}</span>
      {trailing}
      {hint && (
        <span className="row-hint" data-tone={hintTone}>
          {hint}
        </span>
      )}
      {count != null && (
        <span className="count" title={countTitle}>
          {count}
        </span>
      )}
    </>
  );
  const expanded = detail != null;
  return (
    <>
      <div
        ref={rowRef}
        className={
          "side-item" +
          (action ? " is-action" : "") +
          (here ? " is-here" : "") +
          (nested ? " is-nested" : "")
        }
        data-active={active || undefined}
        data-dim={dim || undefined}
        data-pinned={pin?.pinned || undefined}
        data-expanded={expanded || undefined}
      >
        {here ? (
          <div
            className="side-item-main"
            aria-current="page"
            title={title ?? name}
          >
            {inner}
          </div>
        ) : (
          <button
            type="button"
            className="side-item-main"
            data-side-row
            aria-current={active || undefined}
            onClick={onClick}
            title={title ?? name}
          >
            {inner}
          </button>
        )}
        {menu && (
          <OverflowMenu
            items={menu}
            label={`Actions for ${name}`}
            contextMenuOnly
            contextMenuRef={rowRef}
          />
        )}
        {pin && (
          <button
            type="button"
            className="side-item-pin"
            tabIndex={-1}
            aria-pressed={pin.pinned}
            aria-label={pin.pinned ? `Unpin ${name}` : `Pin ${name}`}
            title={pin.pinned ? "Unpin" : "Pin"}
            onClick={pin.onToggle}
          >
            <Icon name="pin" size={11} />
          </button>
        )}
      </div>
      {expanded && <div className="side-item-detail">{detail}</div>}
    </>
  );
}

export interface SideGroupProps {
  title: string;
  /** Undefined while the group's own query is still loading (e.g. snippets,
   *  hooks) — the count span is omitted rather than lying with a `0`. */
  count?: number;
  /** Rows surviving the filter, when one is active. Rendered as `n/total` so a
   *  filtered list never shows a count its rows contradict. */
  shown?: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  search?: SideFilterProps;
  children: ReactNode;
}

/** `n/total` while a filter is narrowing the list, plain total otherwise. */
export function countLabel(total: number, shown?: number): string {
  return shown != null && shown !== total ? `${shown}/${total}` : String(total);
}

/** A group header is a REAL full-row button carrying `aria-expanded`; the add
 *  affordance is a sibling so nothing interactive nests. */
export function SideGroup({
  title,
  count,
  shown,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  search,
  children,
}: SideGroupProps) {
  const disclosure = useSideSearch(search, collapsed, onToggle);
  return (
    <section className="side-group" data-collapsed={collapsed || undefined}>
      <div className="side-group-head">
        <button
          type="button"
          className="side-group-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="chev">
            <Icon name="chevronDown" size={10} />
          </span>
          <span className="t-name">{title}</span>
          {count != null && (
            <span className="t-count">{countLabel(count, shown)}</span>
          )}
        </button>
        {disclosure.trigger}
        {onAdd && (
          <button
            type="button"
            className="g-icon"
            title={addTitle}
            aria-label={addTitle}
            onClick={onAdd}
          >
            <Icon name="plus" size={11} />
          </button>
        )}
      </div>
      {!collapsed && <div className="side-group-items">{disclosure.field}{children}</div>}
    </section>
  );
}

/** A titled group that is NEVER collapsible — for content critical enough
 *  that a chevron nobody's state ever persists would be a dead affordance
 *  (guardrails' Permissions block, agents' Harnesses list). Same spacing as
 *  `SideGroup`, no toggle button. */
export function SideStatic({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="side-group side-group-static">
      <div className="side-group-head">
        <span className="side-group-static-title">{title}</span>
      </div>
      <div className="side-group-items">{children}</div>
    </section>
  );
}

export interface SideFilterProps {
  value: string;
  onChange: (v: string) => void;
  label: string;
}

/** Minimum list size for offering navigator search. */
export { FILTER_THRESHOLD } from "@/lib/navRules";

/** Shared disclosure for section headers and the Projects panel header. */
export function useSideSearch(
  search: SideFilterProps | undefined,
  collapsed = false,
  reveal?: () => void,
  className = "g-icon",
) {
  const [opened, setOpened] = useState(() => !!search?.value);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRequested = useRef(false);
  const open = opened || !!search?.value;
  useEffect(() => {
    if (open && !collapsed && focusRequested.current) {
      inputRef.current?.focus();
      focusRequested.current = false;
    }
  });
  function close() {
    search?.onChange("");
    setOpened(false);
    triggerRef.current?.focus();
  }
  return {
    trigger: search && (
      <button
        ref={triggerRef}
        type="button"
        className={className}
        data-side-search
        title={`Search ${search.label}`}
        aria-label={`Search ${search.label}`}
        aria-expanded={open && !collapsed}
        aria-controls={open && !collapsed ? id : undefined}
        onClick={() => {
          if (open && !collapsed) close();
          else {
            focusRequested.current = true;
            setOpened(true);
            if (collapsed) reveal?.();
          }
        }}
      >
        <Icon name="search" size={11} />
      </button>
    ),
    field: search && open && !collapsed && (
      <div className="side-filter" id={id}>
        <Icon name="search" size={11} />
        <input
          ref={inputRef}
          type="text"
          aria-label={`Search ${search.label}`}
          placeholder={`Search ${search.label}…`}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (search.value) search.onChange("");
              else close();
            }
          }}
        />
        {search.value && (
          <button type="button" className="clear" aria-label="Clear search"
            onClick={() => { search.onChange(""); inputRef.current?.focus(); }}>
            <Icon name="x" size={9} />
          </button>
        )}
      </div>
    ),
  };
}

export function matches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

/** The "Open X" row of a section whose screen IS the list. Standing ON that
 *  route the row cannot go anywhere, so it renders as a non-interactive "you
 *  are here" marker instead of a dead button (P4). Real action rows (Add
 *  source, New snippet) stay buttons. */
export function selfRow(
  currentPath: string,
  navigate: NavigateFunction,
  icon: string,
  label: string,
  href: string,
) {
  const here = currentPath === href;
  const open = `Open ${label.toLowerCase()}`;
  return (
    <SideRow
      action
      here={here}
      active={here}
      leading={<Icon name={icon} size={12} />}
      name={here ? label : open}
      title={here ? `${label} — you are here` : open}
      onClick={() => navigate(href)}
    />
  );
}

// ─── Body module contract (spec §5.7) ────────────────────────────────────────
// Every `components/nav/*Body.tsx` exports `<XGlance/>` (T1+T2, mounted inside
// `.side-dash`), `<XRows/>` (T3+T3x, mounted inside `.side-scroll`), and
// `useXHead()` (band-cell count/add). All five take this ONE props shape.

export interface NavBodyProps {
  registry: Registry | undefined;
  syncEnvelope: SyncReportEnvelope | null | undefined;
  harnesses: HarnessStatus[];
  /** The row that reads as "you are here" — the referrer's path when the
   *  current route left the group (see `lib/sections.ts`). */
  anchorPath: string;
  currentPath: string;
  searchParams: URLSearchParams;
  /** Raw `location.state` — read via `lib/queryFocus.ts`'s `readQueryFocus`
   *  for a screen's durable-after-strip deep-link id (M-3); nothing else in
   *  the panel reads this directly (referrer/anchor derivation stays in
   *  `lib/sections.ts`, unchanged). */
  locationState: unknown;
  navigate: NavigateFunction;
  collapsed: Set<string>;
  toggleCollapsed: (key: string) => void;
  filterFor: (key: string) => string;
  setFilter: (key: string, v: string) => void;
  pinned: Set<string>;
  togglePin: (kind: PinKind, id: string) => void;
}

export interface NavHeadInfo {
  count?: number;
  countTitle?: string;
  add?: { onClick: () => void; title: string };
}
