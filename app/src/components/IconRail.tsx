import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { useAppStore } from "@/store";
import { useRegistry } from "@/hooks/useRegistry";

interface Props {
  onOpenTweaks?: () => void;
  /** When true, render the narrow-only NavPanel drawer toggle at the top. */
  showNavToggle?: boolean;
  /** Toggle the off-canvas NavPanel drawer (narrow window only). */
  onToggleNav?: () => void;
}

export function IconRail({ onOpenTweaks, showNavToggle, onToggleNav }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const openPalette = useAppStore((s) => s.openPalette);
  const recent = useAppStore((s) => s.recentlyVisited);
  const { data: registry } = useRegistry();

  const path = location.pathname;
  const isLibrary =
    path === "/" || path.startsWith("/skill/") || path.startsWith("/bundle/");
  const isProject = path.startsWith("/project/");
  const isSources = path === "/sources" || path.startsWith("/sources/");
  const isSnippets = path === "/snippets";
  const isPermissions = path === "/permissions";
  const isHarnesses = path === "/harnesses";
  const isRemotes = path === "/remotes" || path.startsWith("/remote/");

  // Projects is a real destination: most-recent project → first registered
  // project → command palette when none exist.
  function goProjects() {
    const recentProject = recent.find((r) => r.type === "project");
    if (recentProject) {
      navigate(`/project/${encodeURIComponent(recentProject.name)}`);
      return;
    }
    const first = registry ? Object.keys(registry.projects)[0] : undefined;
    if (first) {
      navigate(`/project/${encodeURIComponent(first)}`);
      return;
    }
    openPalette();
  }

  return (
    <div className="app-rail" data-tauri-drag-region>
      <div className="rail-logo" title="Skill Tree">
        ST
      </div>
      {showNavToggle && (
        <>
          <button
            type="button"
            className="rail-btn"
            aria-label="Toggle navigation"
            title="Toggle navigation"
            onClick={() => onToggleNav?.()}
          >
            <Icon name="panel-left" />
          </button>
          <div className="rail-divider" />
        </>
      )}
      <button
        type="button"
        className="rail-btn"
        aria-current={isLibrary}
        title="Library"
        data-tour="library"
        onClick={() => navigate("/")}
      >
        <Icon name="skill" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isProject}
        title="Projects"
        data-tour="equip"
        onClick={goProjects}
      >
        <Icon name="project" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isSources}
        title="Sources"
        onClick={() => navigate("/sources")}
      >
        <Icon name="source" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isSnippets}
        title="Snippets"
        onClick={() => navigate("/snippets")}
      >
        <Icon name="snippet" />
      </button>
      <div className="rail-divider" />
      <button
        type="button"
        className="rail-btn"
        aria-current={isPermissions}
        title="Permissions"
        onClick={() => navigate("/permissions")}
      >
        <Icon name="shield" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isHarnesses}
        title="Harnesses"
        onClick={() => navigate("/harnesses")}
      >
        <Icon name="plug" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isRemotes}
        title="Remotes"
        onClick={() => navigate("/remotes")}
      >
        <Icon name="remote" />
      </button>
      <div className="rail-sep" />
      <button
        type="button"
        className="rail-btn"
        title="Command palette (⌘K)"
        data-tour="palette"
        onClick={() => openPalette()}
      >
        <Icon name="command" />
      </button>
      <button
        type="button"
        className="rail-btn"
        title="Tweaks"
        data-tour="help"
        onClick={() => onOpenTweaks?.()}
      >
        <Icon name="cog" />
      </button>
    </div>
  );
}
