import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fromNav } from "@/lib/backTarget";
import {
  loadoutBackTarget,
  readLoadoutReturn,
  type ProjectLoadoutReturn,
} from "@/lib/projectLoadoutReturn";

function scrollElement() {
  const layout = document.querySelector<HTMLElement>(
    ".project-loadout-overview",
  );
  return layout && getComputedStyle(layout).overflowY === "auto"
    ? layout
    : document.querySelector<HTMLElement>(".loadout-overview-main");
}
/** Shared by detail links and the workspace's guarded area navigation. */
export function loadoutViewportSnapshot(): Pick<
  ProjectLoadoutReturn,
  "scroll" | "anchor" | "offset"
> {
  const scroller = scrollElement();
  const top = scroller?.getBoundingClientRect().top ?? 0;
  const anchor = [
    ...document.querySelectorAll<HTMLElement>("[data-loadout-focus]"),
  ].find((element) => element.getBoundingClientRect().bottom > top);
  return {
    scroll: scroller?.scrollTop ?? 0,
    anchor: anchor?.dataset.loadoutFocus,
    offset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
  };
}
export function useProjectLoadoutReturn(project: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState(() =>
    readLoadoutReturn(location.state, project),
  );
  const current = useRef(state);
  current.current = state;
  function update(patch: Partial<ProjectLoadoutReturn>) {
    const next = { ...current.current, ...patch };
    current.current = next;
    setState(next);
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: { ...location.state, projectLoadout: next } },
    );
    return next;
  }
  useEffect(() => {
    const saved = readLoadoutReturn(location.state, project);
    const frame = requestAnimationFrame(() => {
      const scroller = scrollElement();
      if (scroller) {
        scroller.scrollTop = saved.scroll;
        const anchor = [
          ...document.querySelectorAll<HTMLElement>("[data-loadout-focus]"),
        ].find((element) => element.dataset.loadoutFocus === saved.anchor);
        if (anchor && saved.offset !== undefined)
          scroller.scrollTop +=
            anchor.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            saved.offset;
      }
      if (saved.focus) {
        const target = [
          ...document.querySelectorAll<HTMLElement>("[data-loadout-focus]"),
        ].find((element) => element.dataset.loadoutFocus === saved.focus);
        const focusTarget =
          (target?.matches("[tabindex]") ? target : undefined) ??
          target?.querySelector<HTMLElement>('[role="button"],button,input') ??
          target ??
          document.querySelector<HTMLElement>('[data-testid="loadout-search"]');
        // The Available panel owns its own scroll container. Let browser focus
        // reveal its saved row, while overview focus retains the captured scroll.
        // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); `[data-loadout-focus]` rows are already mounted by the time this fires, the rAF only lets the scroll restore above settle first.
        if (saved.focus.startsWith("available:") && target) focusTarget?.focus();
        // eslint-disable-next-line no-restricted-syntax -- same already-mounted rAF as above.
        else focusTarget?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
    // Restore once on entry; a filter edit or query refetch must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  function capture(focus?: string, patch?: Partial<ProjectLoadoutReturn>) {
    return update({
      ...loadoutViewportSnapshot(),
      ...(focus ? { focus } : {}),
      ...patch,
    });
  }
  return {
    state,
    update,
    backTarget: () => loadoutBackTarget(project, current.current),
    open: (
      path: string,
      focus?: string,
      patch?: Partial<ProjectLoadoutReturn>,
    ) => {
      const snapshot = capture(focus, patch);
      navigate(path, fromNav(loadoutBackTarget(project, snapshot)));
    },
    area: (tab: string, focus?: string, extra?: Record<string, unknown>) => {
      const snapshot = capture();
      navigate(
        `/project/${encodeURIComponent(project)}?tab=${tab}${focus ? `&focus=${focus}` : ""}`,
        { state: { ...location.state, projectLoadout: snapshot, ...extra } },
      );
    },
  };
}
