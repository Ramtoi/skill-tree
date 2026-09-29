import { FeedbackDialog, FeedbackButton } from "@/components/FeedbackDialog";
import { feedbackScreen, feedbackOS, sanitizeFeedbackContext } from "@/lib/feedbackContext";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Icon } from "@/components/Icon";
import { IconRail } from "@/components/IconRail";
import { BrandMark } from "@/components/BrandMark";
import { NavPanel } from "@/components/NavPanel";
import { StatusBar } from "@/components/StatusBar";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutCheatsheet } from "@/components/ShortcutCheatsheet";
import { TipsTour } from "@/components/TipsTour";
import { ToastContainer } from "@/components/Toast";
import { ProcessTray } from "@/components/loading";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { SettingsToggle } from "@/components/TweaksPanel";
import { PythonError } from "@/screens/PythonError";
import { usePreflight } from "@/hooks/usePreflight";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { SkillEditor } from "@/screens/SkillEditor";
import { SkillAgentEditor } from "@/screens/SkillAgentEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { Sources } from "@/screens/Sources";
import { GlobalPermissions } from "@/screens/GlobalPermissions";
import { Harnesses } from "@/screens/Harnesses";
import { HarnessConfig } from "@/screens/HarnessConfig";
import { HarnessDocEditor } from "@/screens/HarnessDocEditor";
import { Snippets } from "@/screens/Snippets";
import { SnippetEditor } from "@/screens/SnippetEditor";
import { RemotesScreen } from "@/screens/RemotesScreen";
import { CloudTarget } from "@/screens/CloudTarget";
import { HooksScreen } from "@/screens/HooksScreen";
import { HookEditor } from "@/screens/HookEditor";
import { LocalAgentUsage } from "@/screens/LocalAgentUsage";
import { UsageProjectRoute } from "@/screens/usage/UsageProjectRoute";
import { UsageSessionRoute } from "@/screens/usage/UsageSessionRoute";
import { UsagePinnedSessionsRoute } from "@/screens/usage/UsagePinnedSessionsRoute";
import { BackupScreen } from "@/screens/BackupScreen";
import { RecoveryWizard } from "@/screens/RecoveryWizard";
import { CompanionGateProvider } from "@/hooks/useCompanionGate";
import { useShipWith } from "@/hooks/useShipWith";

// Dev-only iteration surface — lazy + DEV-gated so it never reaches the
// production chunk (visual capture runs the Vite dev server, so it stays
// reachable there).
const Styleguide = import.meta.env.DEV
  ? lazy(() =>
      import("@/screens/Styleguide").then((m) => ({ default: m.Styleguide })),
    )
  : null;
import { BootstrapWizard, type BootstrapState } from "@/screens/BootstrapWizard";
import { useTweaks } from "@/hooks/useTweaks";
import { focusScreenSearch, isTextEntryTarget } from "@/lib/focusScreenSearch";
import { focusNavPanel } from "@/lib/focusNavPanel";
import { useTrackRecent } from "@/hooks/useRecent";
import { resolvableRecent } from "@/lib/recentResolve";
import { useRegistry } from "@/hooks/useRegistry";
import { useChords } from "@/hooks/useChords";
import { KEYMAP, type KeymapCtx } from "@/lib/keymap";
// Route → section/group lives in `lib/` (NOT here): App.tsx pulls in every
// screen, so exporting it from this module would drag the whole screen graph
// into the NavPanel and close an import cycle.
import { contentGroupForPath, groupForLocation, isContextMix } from "@/lib/sections";
import { useDisableNativeTextAssist } from "@/lib/nativeTextAssist";
import { NavigationGuard } from "@/lib/navGuard";
import { tipsDone } from "@/lib/tips";
import { useAppStore } from "@/store";

/** `/bundle/:name` renders the Library in bundle mode. `react-router` only
 *  remounts a route's element across DIFFERENT matches — a param change on
 *  the SAME route (bundle A → bundle B) leaves `SkillLibrary` mounted, so
 *  `key={name}` forces the remount that resets its search box, facets and
 *  open details between bundles. */
function LibraryRoute() {
  const { name } = useParams<{ name: string }>();
  return <SkillLibrary key={name} />;
}

function AppShell() {
  const [tweaks] = useTweaks();
  const location = useLocation();
  const navigate = useNavigate();
  // The chrome hue is per GROUP, not per section — `data-section` keeps its
  // attribute name (CSS + tests address it) but carries one of five group ids.
  const group = groupForLocation(location.pathname, location.state);
  // The CONTENT group ignores the referrer — it's the route's own section, so
  // a skill opened from a project still reports "context" here even while the
  // chrome (`group`, above) reads "projects". The header uses both to blend a
  // second hue in rather than silently picking the chrome's.
  const contentGroup = contentGroupForPath(location.pathname);
  const contextMix = isContextMix(location.pathname, location.state);
  const feedbackOpen = useAppStore(s => s.feedbackOpen);
  const feedbackTabs = useAppStore(s => s.feedbackTabs);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const openPalette = useAppStore((s) => s.openPalette);
  const recentlyVisited = useAppStore((s) => s.recentlyVisited);
  const closePalette = useAppStore((s) => s.closePalette);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const tipsOpen = useAppStore((s) => s.tipsOpen);
  const degradedMode = useAppStore((s) => s.degradedMode);
  // Deliberately NOT read by the tips-tour effect below: deferring setup is not
  // a broken runtime, so the tour keeps firing on exactly its own conditions.
  const bootstrapDeferred = useAppStore((s) => s.bootstrapDeferred);
  const openTips = useAppStore((s) => s.openTips);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px)").matches,
  );
  const [navOpen, setNavOpen] = useState(false);
  const { data: registry } = useRegistry();
  // The shared "Ship this with a skill…" host (wave 4c unit 3/4) — mounted
  // ONCE here, exactly like `CompanionGateProvider` below, so every screen's
  // own `useShipWith()` call gets `.open()` without also rendering a second
  // `ShipWithFlow` (two mounts of the same module-level store would portal
  // two overlays for one open flow).
  const shipWith = useShipWith();

  useTrackRecent();

  // Developer tool: kill macOS/WebKit autocorrect, autocapitalize, and spellcheck
  // on every text field app-wide (see lib/nativeTextAssist).
  useDisableNativeTextAssist();

  // Chord layer (ux-command-layer). One keymap registry → handlers + hints +
  // cheatsheet. Ctx is read via a ref inside the hook, so a fresh object each
  // render is fine.
  const keymapCtx = useMemo<KeymapCtx>(
    () => ({
      navigate: (to) => navigate(to),
      openPalette: (verbId) => openPalette(verbId),
      lastProjectRoute: () => {
        // `recentlyVisited` is persisted and never pruned, so `g p` would
        // otherwise keep landing on a project that has since been removed.
        const recent = resolvableRecent(recentlyVisited, registry).find(
          (r) => r.type === "project",
        );
        const name = recent?.name ?? Object.keys(registry?.projects ?? {})[0];
        return name ? `/project/${encodeURIComponent(name)}` : "";
      },
      firstBundleRoute: () => {
        const name = Object.keys(registry?.bundles ?? {})[0];
        return name ? `/bundle/${encodeURIComponent(name)}` : "";
      },
      focusNavigator: () => {
        // Narrow: open the drawer first, then focus once it has rendered.
        if (narrow) setNavOpen(true);
        // eslint-disable-next-line no-restricted-syntax -- `focusNavPanel` queries a chrome element that is always mounted (CSS drives the drawer's open state, not conditional rendering); the rAF only waits out the drawer's own reveal transition, not a commit.
        requestAnimationFrame(() => focusNavPanel());
      },
    }),
    [navigate, openPalette, recentlyVisited, registry, narrow],
  );
  useChords(KEYMAP, keymapCtx);

  // Single writer for the density side-effect, sourced from the shared store.
  useEffect(() => {
    document.documentElement.setAttribute("data-density", tweaks.density);
  }, [tweaks.density]);

  // Track macOS fullscreen state so the titlebar inset collapses when the
  // traffic lights auto-hide. Covers both the keyboard toggle and the native
  // green button (resize fires on the fullscreen-space transition).
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    win.isFullscreen().then(setIsFullscreen);
    win
      .onResized(async () => setIsFullscreen(await win.isFullscreen()))
      .then((un) => {
        // The effect may have been cleaned up before onResized resolved; if so,
        // tear the listener down immediately so it can't leak or fire
        // setIsFullscreen on an unmounted shell.
        if (cancelled) un();
        else unlisten = un;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Track narrow-window state so the NavPanel collapses out of the grid into an
  // off-canvas drawer (mirrors the isFullscreen listener). Leaving narrow mode
  // also force-closes the drawer so it can never linger when re-docked.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches);
      if (!e.matches) setNavOpen(false);
    };
    setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // FOCUS CONTAINMENT for the narrow drawer. `inert` on the CLOSED panel is
  // only half the contract: while the drawer is OPEN over a scrim, Tab used to
  // walk straight past it into the content behind, and closing it stranded
  // focus on a row that had just become inert. So the main column goes inert
  // for exactly as long as the drawer is over it (the rail stays reachable —
  // it owns the toggle), and focus returns to whichever control opened it.
  //
  // `focusWasInNav` is sampled continuously rather than read at close time
  // because applying `inert` blurs the active element first, so by the time the
  // close effect runs the browser has already moved focus to <body>.
  const focusWasInNav = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const node = e.target as Node | null;
      focusWasInNav.current =
        !!node && !!document.querySelector(".app-side")?.contains(node);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const navWasOpen = useRef(navOpen);
  useEffect(() => {
    const wasOpen = navWasOpen.current;
    navWasOpen.current = navOpen;
    if (!wasOpen || navOpen || !focusWasInNav.current) return;
    focusWasInNav.current = false;
    // The rail toggle when the rail is on screen, the fixed handle otherwise.
    document
      .querySelector<HTMLElement>(
        '.nav-handle, .app-rail button[title="Toggle navigation"]',
      )
      ?.focus();
  }, [navOpen]);

  // Auto-close the drawer on navigation so tapping a nav item dismisses it.
  // Keyed on `location.key`, not `pathname`: tapping the row you are already on
  // is still a navigation the user made, and leaving the drawer parked over the
  // content after it looks like the tap was swallowed.
  useEffect(() => {
    setNavOpen(false);
  }, [location.key]);

  const { data: preflight, isLoading } = usePreflight();
  const pythonOk = preflight?.ok === true;

  const {
    data: bootstrapState,
    isLoading: bootstrapLoading,
    error: bootstrapError,
  } = useQuery({
    queryKey: qk.bootstrap(),
    queryFn: () => invoke<BootstrapState>("bootstrap_check"),
    enabled: pythonOk,
    staleTime: 5 * 60_000,
  });

  const settingsAvailable = !isLoading && !(pythonOk && bootstrapLoading) &&
    (degradedMode || (pythonOk && !bootstrapError &&
      (!bootstrapState?.needs_bootstrap || bootstrapDeferred)));

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (feedbackOpen) return;
      const target = e.target as HTMLElement | null;
      // Covers contenteditable (CodeMirror) too — see isTextEntryTarget.
      const isInput = isTextEntryTarget(target);

      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (settingsAvailable && !settingsOpen && !tipsOpen) openSettings();
      } else if (settingsOpen) {
        // Settings owns focus; all page-level shortcuts, including palette and
        // search, stay inert until its modal closes.
        return;
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      } else if (e.key === "/" && !isInput && !paletteOpen && !tipsOpen) {
        // The screen search input may live in the header row OR the subheader.
        // Focus whichever slot holds it (see lib/focusScreenSearch). Suppressed
        // while the tips tour owns the keyboard (mirrors the paletteOpen guard).
        if (focusScreenSearch()) e.preventDefault();
      } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const win = getCurrentWindow();
        win.isFullscreen().then((fs) => win.setFullscreen(!fs));
      } else if (e.key === "Escape") {
        if (paletteOpen) closePalette();
        else setNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feedbackOpen, paletteOpen, tipsOpen, settingsOpen, settingsAvailable, openSettings, openPalette, closePalette]);

  // First-run tips tour auto-start. Fires at most once per session, and only
  // when the user hasn't seen it, isn't in degraded mode, and the bootstrap
  // gate has cleared — AND we have a genuine FRESHNESS signal: either the
  // bootstrap wizard just completed a fresh install (store flag, set only when
  // zero skills pre-existed), or the registry is empty (installed + restarted
  // before ever seeing the tour). A populated pre-bootstrap-version upgrade that
  // completes the wizard must NOT auto-trigger; those users reach it manually
  // (palette / cheatsheet).
  const freshBootstrapCompleted = useAppStore((s) => s.freshBootstrapCompleted);
  const tipsAutoStartedRef = useRef(false);
  useEffect(() => {
    const needs = bootstrapState?.needs_bootstrap;

    if (tipsAutoStartedRef.current || settingsOpen || feedbackOpen) return;
    if (tipsDone() || degradedMode) return;
    if (!pythonOk || bootstrapLoading) return;
    if (needs !== false) return; // gate still showing or state unknown
    const freshEmpty =
      !!registry &&
      Object.keys(registry.skills).length === 0 &&
      Object.keys(registry.projects).length === 0;
    if (freshBootstrapCompleted || freshEmpty) {
      tipsAutoStartedRef.current = true;
      openTips();
    }
  }, [
    bootstrapState,
    registry,
    degradedMode,
    pythonOk,
    bootstrapLoading,
    openTips,
    freshBootstrapCompleted,
    settingsOpen,
    feedbackOpen,
  ]);

  const gate = isLoading || (pythonOk && bootstrapLoading) ? "loading"
    : !degradedMode && (!pythonOk || !!bootstrapError) ? "runtime-error"
    : pythonOk && bootstrapState?.needs_bootstrap && !degradedMode && !bootstrapDeferred ? "setup" : null;
  const screen = gate ?? feedbackScreen(location.pathname);
  const feedbackContext = sanitizeFeedbackContext({ screen, tab: feedbackTabs[screen] ?? "none",
    appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown", os: feedbackOS(navigator.platform) });
  const feedbackHost = <FeedbackDialog context={feedbackContext} />;

  if (isLoading || (pythonOk === true && bootstrapLoading)) {
    return (
      <>{feedbackHost}<div
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--fg-mute)",
          fontSize: 13,
        }}
      >
        Starting…
        <FeedbackButton context={feedbackContext} gate />
      </div></>
    );
  }

  // Honest runtime gate: a failed preflight OR a failed bootstrap_check must
  // surface the real error — never fall through to the Library, which would
  // misreport it as "Cannot read registry.yaml". Degraded mode opts out.
  if (!degradedMode && (!pythonOk || !!bootstrapError)) {
    return (
      <>{feedbackHost}<div
        className="app"
        data-gate="true"
        data-rail="false"
        data-rail-expanded="false"
        data-fullscreen={isFullscreen ? "true" : "false"}
      >
        <main className="app-main">
          <PythonError
            preflight={preflight}
            bootstrapError={bootstrapError ? String(bootstrapError) : undefined}
          />
        </main>
        <FeedbackButton context={feedbackContext} gate />
        <ToastContainer />
      </div></>
    );
  }

  // Bootstrap takes precedence over routes (runtime gate above already passed).
  // `bootstrapDeferred` is the wizard's own "Set up later": it bypasses the gate
  // for this session WITHOUT claiming the runtime is broken, so the tour, the
  // live connector catalog and every other degraded-mode casualty stay intact.
  if (
    pythonOk &&
    bootstrapState?.needs_bootstrap &&
    !degradedMode &&
    !bootstrapDeferred
  ) {
    return (
      <>{feedbackHost}<div
        className="app"
        data-gate="true"
        data-rail="false"
        data-rail-expanded="false"
        data-fullscreen={isFullscreen ? "true" : "false"}
      >
        <main className="app-main">
          <BootstrapWizard state={bootstrapState} />
        </main>
        <FeedbackButton context={feedbackContext} gate />
        <ToastContainer />
      </div></>
    );
  }

  const showRoutes = pythonOk || degradedMode;

  return (
    <>{feedbackHost}<div
      className="app"
      data-rail={tweaks.showRail ? "true" : "false"}
      data-rail-expanded={tweaks.railExpanded ? "true" : "false"}
      data-fullscreen={isFullscreen ? "true" : "false"}
      data-nav={tweaks.showNav ? "true" : "false"}
      data-narrow={narrow ? "true" : "false"}
      data-nav-open={navOpen ? "true" : "false"}
      data-section={group}
      data-content-section={contentGroup}
      {...(contextMix ? { "data-context-mix": "true" } : {})}
    >
      {/* Rail-column chrome: keeps the rail's glyphs clear of the macOS traffic
          lights, and hosts the brand mark in the band cell over the rail (the
          StatusBar still spells the name out). The navigator's own head
          (`.side-head`) fills the band beside it. */}
      <div className="app-topbar" data-tauri-drag-region>
        {tweaks.showRail && (
          <div className="topbar-logo" aria-hidden="true">
            <BrandMark size={26} strokeWidth={1.7} dotR={1.85} />
          </div>
        )}
      </div>
      {tweaks.showRail && (
        <IconRail
          onOpenSettings={() => openSettings()}
          showNavToggle={narrow}
          onToggleNav={() => setNavOpen((v) => !v)}
        />
      )}
      {/* Narrow + rail hidden leaves no chrome to host the drawer toggle, so a
          fixed handle takes over. It renders even when the navigator itself is
          switched off: at narrow the panel is still a drawer, so this is the
          one control that makes the state recoverable. */}
      {narrow && !tweaks.showRail && (
        <button
          type="button"
          className="nav-handle"
          aria-label="Open navigator"
          aria-expanded={navOpen}
          title="Open navigator"
          onClick={() => setNavOpen((v) => !v)}
        >
          <Icon name="panel-left" size={14} />
        </button>
      )}
      {/* Off-canvas at narrow widths: made `inert` while closed so a hidden
          drawer never receives Tab focus or a screen-reader visit. */}
      <NavPanel inert={narrow && !navOpen} narrow={narrow} />
      {narrow && navOpen && (
        <div
          className="app-nav-scrim"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <main className="app-main" tabIndex={-1} inert={narrow && navOpen}>
        {showRoutes ? (
          <Routes>
            <Route path="/" element={<SkillLibrary />} />
            <Route path="/skill/:name" element={<SkillEditor />} />
            <Route path="/skill/:name/agent/:agent" element={<SkillAgentEditor />} />
            <Route path="/project/:name" element={<ProjectWorkspace />} />
            <Route path="/bundle/:name" element={<LibraryRoute />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/permissions" element={<GlobalPermissions />} />
            <Route path="/harnesses" element={<Harnesses />} />
            <Route path="/harness/:id" element={<HarnessConfig />} />
            <Route path="/harness/:id/doc" element={<HarnessDocEditor />} />
            <Route path="/snippets" element={<Snippets />} />
            <Route path="/snippet/:name" element={<SnippetEditor />} />
            <Route path="/hooks" element={<HooksScreen />} />
            <Route path="/hook/:name" element={<HookEditor />} />
            <Route path="/remotes" element={<RemotesScreen />} />
            <Route path="/remote/:id" element={<RemotesScreen />} />
            <Route path="/cloud/:id" element={<CloudTarget />} />
            <Route path="/usage" element={<LocalAgentUsage />} />
            <Route path="/usage/project/:name" element={<UsageProjectRoute />} />
            <Route path="/usage/session/:id" element={<UsageSessionRoute />} />
            <Route path="/usage/pinned" element={<UsagePinnedSessionsRoute />} />
            <Route path="/backup" element={<BackupScreen />} />
            <Route path="/recovery" element={<RecoveryWizard />} />
            {Styleguide ? (
              <Route
                path="/styleguide"
                element={
                  <Suspense fallback={null}>
                    <Styleguide />
                  </Suspense>
                }
              />
            ) : null}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <PythonError preflight={preflight} />
        )}
      </main>
      <StatusBar feedbackContext={feedbackContext} />
      <CommandPalette />
      <ShortcutCheatsheet />
      <TipsTour />
      <ToastContainer />
      {/* The equip consequence dialog (I1/D2) — portalled here so no call site
          (six of them, incl. the palette) owns an overlay of its own. */}
      <CompanionGateProvider />
      {/* The reverse-link entry points (Hooks / sub-agents / Permissions) all
          call `useShipWith().open(...)` and rely on THIS single mount to
          render the picker or the seeded sheet — see the comment above. */}
      {shipWith.element}
      <ProcessTray />
      <SettingsToggle onClick={() => openSettings()} visible={!tweaks.showRail} />
      <SettingsDialog />
    </div></>
  );
}

export default function App() {
  return (
    <HashRouter>
      {/* Wraps the router's navigator, so a screen holding unsaved work can
          refuse the rail, a NavPanel row, the palette, a chord and the back
          arrow alike — one guard instead of eight call sites. */}
      <NavigationGuard>
        <AppShell />
      </NavigationGuard>
    </HashRouter>
  );
}
