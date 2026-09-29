/**
 * Focus the navigator's currently-tabbable row (`useSideNav`'s roving
 * tabindex keeps exactly one `[data-side-row]` at `tabindex="0"`). Mirrors
 * `focusScreenSearch` (spec §3.2): a small, independently-testable helper the
 * `g ⇧n` chord calls through `KeymapCtx.focusNavigator`.
 *
 * Returns `false` — without throwing — when the aside is `inert` (narrow,
 * drawer closed), when it is not rendered at all (`showNav` off hides
 * `.app-side` with `display:none`, so `offsetParent === null`), or when no
 * tabbable row exists yet.
 */
export function focusNavPanel(root: ParentNode = document): boolean {
  const aside = root.querySelector<HTMLElement>(".app-side");
  if (!aside || aside.hasAttribute("inert")) return false;
  if (aside.offsetParent === null) return false;
  const row = aside.querySelector<HTMLElement>('[data-side-row][tabindex="0"]');
  if (!row) return false;
  row.focus();
  return true;
}
