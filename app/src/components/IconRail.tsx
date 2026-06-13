import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { useAppStore } from "@/store";
import { useRegistry } from "@/hooks/useRegistry";

interface Props {
  onOpenTweaks?: () => void;
}

export function IconRail({ onOpenTweaks }: Props) {
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
      <button
        type="button"
        className="rail-btn"
        aria-current={isLibrary}
        title="Library"
        onClick={() => navigate("/")}
      >
        <Icon name="skill" />
      </button>
      <button
        type="button"
        className="rail-btn"
        aria-current={isProject}
        title="Projects"
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
      <div className="rail-sep" />
      <button
        type="button"
        className="rail-btn"
        title="Command palette (⌘K)"
        onClick={() => openPalette()}
      >
        <Icon name="command" />
      </button>
      <button
        type="button"
        className="rail-btn"
        title="Tweaks"
        onClick={() => onOpenTweaks?.()}
      >
        <Icon name="cog" />
      </button>
    </div>
  );
}
