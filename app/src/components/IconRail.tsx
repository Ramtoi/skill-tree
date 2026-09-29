import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { useAppStore } from "@/store";
import { useTweaks } from "@/hooks/useTweaks";
import { useRegistry } from "@/hooks/useRegistry";
import { sectionForLocation } from "@/lib/sections";
import { resolvableRecent } from "@/lib/recentResolve";

interface Props {
  onOpenSettings?: () => void;
  /** When true, render the narrow-only NavPanel drawer toggle at the top. */
  showNavToggle?: boolean;
  /** Toggle the off-canvas NavPanel drawer (narrow window only). */
  onToggleNav?: () => void;
}

interface RailButtonProps {
  /** Tooltip — kept in BOTH modes: it is the only affordance while collapsed,
   *  and harmless (redundant) once the label is on screen. Several tests and
   *  the tips tour address rail buttons by title, so it is load-bearing. */
  title: string;
  /** Short label rendered beside the icon in expanded mode. CSS hides it when
   *  collapsed (display:none) so toggling never reflows the button contents. */
  label: string;
  icon: string;
  onClick: () => void;
  /** Omitted (not `false`) for utility buttons, which have no route to be on. */
  current?: boolean;
  /** `data-tour` anchor id for the first-run tips tour. */
  tour?: string;
  /** A SECOND tour anchor on the same button. An element carries one
   *  `data-tour`, but two tour steps can legitimately point at one control
   *  (Projects is both "register a project" and "equip a project"), so the
   *  extra id rides on a zero-chrome overlay that reports the button's own
   *  rect. Rail buttons are always mounted, which is what the tour's
   *  "works from any route" contract needs (lib/tips.ts). */
  extraTour?: string;
  ariaLabel?: string;
  /** For toggle-style buttons (the expand chevron): announce on/off state
   *  instead of relying on a mutating label alone. */
  ariaPressed?: boolean;
}

function RailButton({
  title,
  label,
  icon,
  onClick,
  current,
  tour,
  extraTour,
  ariaLabel,
  ariaPressed,
}: RailButtonProps): ReactNode {
  return (
    <button
      type="button"
      className="rail-btn live-glint"
      aria-current={current}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      data-tour={tour}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {extraTour && (
        <span className="rail-tour-anchor" data-tour={extraTour} aria-hidden="true" />
      )}
    </button>
  );
}

/** Group boundary in the rail. Collapsed it IS the old `.rail-divider` (56px
 *  has no room for a word, so CSS shows the hairline alone); expanded it names
 *  the intent group the buttons under it belong to. */
function RailCaption({ label }: { label: string }): ReactNode {
  return (
    <div className="rail-caption">
      <span>{label}</span>
    </div>
  );
}

export function IconRail({ onOpenSettings, showNavToggle, onToggleNav }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const openPalette = useAppStore((s) => s.openPalette);
  const recent = useAppStore((s) => s.recentlyVisited);
  const [tweaks, setTweak] = useTweaks();
  const { data: registry } = useRegistry();

  // ONE route→section table (`lib/sections.ts`) decides both the rail pill and
  // the panel header. Hand-rolled predicates here used to disagree with it on
  // `/harness/:id`, `/harness/:id/doc` and `/cloud/:id`, so the panel announced
  // a section while the rail showed no active destination at all.
  const path = location.pathname;
  const section = sectionForLocation(path, location.state);
  const isLibrary = section === "library";
  const isProject = section === "projects";
  const isSources = section === "sources";
  const isSnippets = section === "snippets";
  const isHooks = section === "hooks";
  const isPermissions = section === "permissions";
  const isHarnesses = section === "harnesses";
  const isRemotes = section === "remotes";
  const isUsage = section === "usage";
  const isBackup = section === "backup";

  const expanded = tweaks.railExpanded;

  // Projects is a real destination: most-recent project → first registered
  // project → command palette when none exist. The "most recent" step reads a
  // PERSISTED list, so it is reconciled against the registry first — otherwise
  // a project you removed keeps hijacking this button into "Project not found".
  function goProjects() {
    const recentProject = resolvableRecent(recent, registry).find(
      (r) => r.type === "project",
    );
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
      {showNavToggle && (
        <>
          <RailButton
            title="Toggle navigation"
            ariaLabel="Toggle navigation"
            label="Navigation"
            icon="panel-left"
            onClick={() => onToggleNav?.()}
          />
          <div className="rail-divider" />
        </>
      )}
      {/* Intent groups (top → bottom): the campaign you run · the CONTEXT you
          hand an agent · the GUARDRAILS it runs under · the AGENTS that run it
          · everything ELSEWHERE (off this machine, or on its way here). The
          captions and the chrome hue come from `lib/sections.ts`'s group layer;
          the per-destination pill still keys off the section. */}
      <RailButton
        title="Projects"
        label="Projects"
        icon="project"
        tour="equip"
        // The tour's "register a project" step used to anchor on the NavPanel's
        // Projects "+", which only exists while the Projects section is on
        // screen. The rail button is always mounted, so the anchor moved here.
        extraTour="add-project"
        current={isProject}
        onClick={goProjects}
      />
      <RailCaption label="Context" />
      <RailButton
        title="Library"
        label="Library"
        icon="library"
        tour="library"
        current={isLibrary}
        onClick={() => navigate("/")}
      />
      <RailButton
        title="Snippets"
        label="Snippets"
        icon="snippet"
        current={isSnippets}
        onClick={() => navigate("/snippets")}
      />
      <RailCaption label="Guardrails" />
      <RailButton
        title="Permissions"
        label="Permissions"
        icon="permissions"
        current={isPermissions}
        onClick={() => navigate("/permissions")}
      />
      <RailButton
        title="Hooks"
        label="Hooks"
        icon="hook"
        current={isHooks}
        onClick={() => navigate("/hooks")}
      />
      <RailCaption label="Agents" />
      <RailButton
        title="Harnesses"
        label="Harnesses"
        icon="harness"
        current={isHarnesses}
        onClick={() => navigate("/harnesses")}
      />
      <RailButton
        title="Usage / Local Agent Usage"
        label="Usage"
        icon="usage"
        current={isUsage}
        onClick={() => navigate("/usage")}
      />
      <RailCaption label="Elsewhere" />
      <RailButton
        title="Sources"
        label="Sources"
        icon="source"
        current={isSources}
        onClick={() => navigate("/sources")}
      />
      <RailButton
        title="Remotes"
        label="Remotes"
        icon="remote"
        current={isRemotes}
        onClick={() => navigate("/remotes")}
      />
      {/* Backup was reachable only by chord (`g ⇧b`) and the palette — a
          destination the navigator names but the rail could not reach. */}
      <RailButton
        title="Backup"
        label="Backup"
        icon="archive"
        current={isBackup}
        onClick={() => navigate("/backup")}
      />
      <div className="rail-sep" />
      <RailButton
        title="Command palette (⌘K)"
        label="Palette"
        icon="command"
        tour="palette"
        onClick={() => openPalette()}
      />
      <RailButton
      title="Settings"
      label="Settings"
      icon="cog"
      tour="help"
      onClick={() => onOpenSettings?.()}
      />
      {/* Primary affordance for the labels mode (the Tweaks panel carries a
          secondary switch). Sits last so it reads as chrome for the rail
          itself, not another destination. Hidden in narrow windows
          (`showNavToggle` IS the narrow signal): CSS forces the compact rail
          there, so the chevron would be an inert control that then lies
          about its state. */}
      {!showNavToggle && (
        <RailButton
          title={expanded ? "Collapse rail" : "Expand rail (show labels)"}
          ariaLabel={expanded ? "Collapse rail" : "Expand rail (show labels)"}
          ariaPressed={expanded}
          label="Collapse"
          icon={expanded ? "chevron-left" : "chevron-right"}
          onClick={() => setTweak("railExpanded", !expanded)}
        />
      )}
    </div>
  );
}
