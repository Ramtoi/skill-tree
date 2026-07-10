import { useEffect, useMemo, useRef, useState } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { IconRail } from "@/components/IconRail";
import { NavPanel } from "@/components/NavPanel";
import { StatusBar } from "@/components/StatusBar";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutCheatsheet } from "@/components/ShortcutCheatsheet";
import { TipsTour } from "@/components/TipsTour";
import { ToastContainer } from "@/components/Toast";
import { ProcessTray } from "@/components/loading";
import { TweaksPanel, TweaksToggle } from "@/components/TweaksPanel";
import { PythonError } from "@/screens/PythonError";
import { usePreflight } from "@/hooks/usePreflight";
import { SkillLibrary } from "@/screens/SkillLibrary";
import { SkillEditor } from "@/screens/SkillEditor";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { BundleManager } from "@/screens/BundleManager";
import { Sources } from "@/screens/Sources";
import { GlobalPermissions } from "@/screens/GlobalPermissions";
import { Harnesses } from "@/screens/Harnesses";
import { HarnessConfig } from "@/screens/HarnessConfig";
import { Snippets } from "@/screens/Snippets";
import { RemotesScreen } from "@/screens/RemotesScreen";
import { BootstrapWizard, type BootstrapState } from "@/screens/BootstrapWizard";
import { useTweaks } from "@/hooks/useTweaks";
import { focusScreenSearch } from "@/lib/focusScreenSearch";
import { useTrackRecent } from "@/hooks/useRecent";
import { useRegistry } from "@/hooks/useRegistry";
import { useChords } from "@/hooks/useChords";
import { KEYMAP, type KeymapCtx } from "@/lib/keymap";
import { useDisableNativeTextAssist } from "@/lib/nativeTextAssist";
import { tipsDone } from "@/lib/tips";
import { useAppStore } from "@/store";

/** Route → rail-section, for the chrome-only `data-section` hue (see App.css). */
function sectionForPath(path: string): string {
  if (path.startsWith("/project/")) return "projects";
  if (path === "/sources" || path.startsWith("/sources/")) return "sources";
  if (path === "/snippets" || path.startsWith("/snippets/")) return "snippets";
  if (path === "/permissions") return "permissions";
  if (path === "/harnesses" || path.startsWith("/harness/")) return "harnesses";
  if (path === "/remotes" || path.startsWith("/remote/")) return "remotes";
  // "/", "/skill/*", "/bundle/*" and any fallback all belong to Library.
  return "library";
}

function AppShell() {
  const [tweaks] = useTweaks();
  const location = useLocation();
  const navigate = useNavigate();
  const section = sectionForPath(location.pathname);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const openPalette = useAppStore((s) => s.openPalette);
  const recentlyVisited = useAppStore((s) => s.recentlyVisited);
  const closePalette = useAppStore((s) => s.closePalette);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const tipsOpen = useAppStore((s) => s.tipsOpen);
  const degradedMode = useAppStore((s) => s.degradedMode);
  const openTips = useAppStore((s) => s.openTips);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px)").matches,
  );
  const [navOpen, setNavOpen] = useState(false);
  const { data: registry } = useRegistry();
  const skillCount = registry ? Object.keys(registry.skills).length : 0;

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
        const recent = recentlyVisited.find((r) => r.type === "project");
        const name = recent?.name ?? Object.keys(registry?.projects ?? {})[0];
        return name ? `/project/${encodeURIComponent(name)}` : "";
      },
      firstBundleRoute: () => {
        const name = Object.keys(registry?.bundles ?? {})[0];
        return name ? `/bundle/${encodeURIComponent(name)}` : "";
      },
    }),
    [navigate, openPalette, recentlyVisited, registry],
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

  // Auto-close the drawer on navigation so tapping a nav item dismisses it.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const { data: preflight, isLoading } = usePreflight();
  const pythonOk = preflight?.ok === true;

  const {
    data: bootstrapState,
    isLoading: bootstrapLoading,
    error: bootstrapError,
  } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => invoke<BootstrapState>("bootstrap_check"),
    enabled: pythonOk,
    staleTime: 5 * 60_000,
  });

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
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
  }, [paletteOpen, tipsOpen, openPalette, closePalette]);

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

    if (tipsAutoStartedRef.current) return;
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
  ]);

  if (isLoading || (pythonOk === true && bootstrapLoading)) {
    return (
      <div
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--fg-mute)",
          fontSize: 13,
        }}
      >
        Starting…
      </div>
    );
  }

  // Honest runtime gate: a failed preflight OR a failed bootstrap_check must
  // surface the real error — never fall through to the Library, which would
  // misreport it as "Cannot read registry.yaml". Degraded mode opts out.
  if (!degradedMode && (!pythonOk || !!bootstrapError)) {
    return (
      <div
        className="app"
        data-rail="false"
        data-fullscreen={isFullscreen ? "true" : "false"}
      >
        <main className="app-main">
          <PythonError
            preflight={preflight}
            bootstrapError={bootstrapError ? String(bootstrapError) : undefined}
          />
        </main>
        <ToastContainer />
      </div>
    );
  }

  // Bootstrap takes precedence over routes (runtime gate above already passed)
  if (pythonOk && bootstrapState?.needs_bootstrap && !degradedMode) {
    return (
      <div
        className="app"
        data-rail="false"
        data-fullscreen={isFullscreen ? "true" : "false"}
      >
        <main className="app-main">
          <BootstrapWizard state={bootstrapState} />
        </main>
        <ToastContainer />
      </div>
    );
  }

  const showRoutes = pythonOk || degradedMode;

  return (
    <div
      className="app"
      data-rail={tweaks.showRail ? "true" : "false"}
      data-fullscreen={isFullscreen ? "true" : "false"}
      data-narrow={narrow ? "true" : "false"}
      data-nav-open={navOpen ? "true" : "false"}
      data-section={section}
    >
      <div className="app-topbar" data-tauri-drag-region>
        <h1>SKILL TREE</h1>
        <span className="meta">{skillCount} skills</span>
      </div>
      {tweaks.showRail && (
        <IconRail
          onOpenTweaks={() => setTweaksOpen((v) => !v)}
          showNavToggle={narrow}
          onToggleNav={() => setNavOpen((v) => !v)}
        />
      )}
      <NavPanel />
      {narrow && tweaks.showRail && navOpen && (
        <div
          className="app-nav-scrim"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <main className="app-main">
        {showRoutes ? (
          <Routes>
            <Route path="/" element={<SkillLibrary />} />
            <Route path="/skill/:name" element={<SkillEditor />} />
            <Route path="/project/:name" element={<ProjectWorkspace />} />
            <Route path="/bundle/:name" element={<BundleManager />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/permissions" element={<GlobalPermissions />} />
            <Route path="/harnesses" element={<Harnesses />} />
            <Route path="/harness/:id" element={<HarnessConfig />} />
            <Route path="/snippets" element={<Snippets />} />
            <Route path="/remotes" element={<RemotesScreen />} />
            <Route path="/remote/:id" element={<RemotesScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <PythonError preflight={preflight} />
        )}
      </main>
      <StatusBar />
      <CommandPalette />
      <ShortcutCheatsheet />
      <TipsTour />
      <ToastContainer />
      <ProcessTray />
      <TweaksToggle onClick={() => setTweaksOpen((v) => !v)} />
      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
