import type { CSSProperties, DragEvent, ReactNode } from "react";
import { Icon } from "./Icon";
import { ResourceCard } from "./ResourceRow";
import { InvocationBadge } from "./InvocationBadge";
import { KindTag, ScopeBadge } from "./Tag";

export type SkillCardKind = "claude-skill" | "mcp-server" | "SKILL" | "MCP";
export type SkillCardScope =
  | "global"
  | "portable"
  | "project-specific"
  | "project";

export interface SkillCardProps {
  name: string;
  kind?: SkillCardKind;
  scope: SkillCardScope;
  description?: string;
  equipped?: boolean;
  via?: "bundle" | null;
  dim?: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onUnequipped?: () => void;
  equipToggleTitle?: string;
  source?: ReactNode;
  leadingBadge?: ReactNode;
  /** Registry invocation mirror — renders a deviation-only InvocationBadge. */
  invocation?: string;
  /** Per-project triggering override control (workspace cards). */
  invocationControl?: ReactNode;
  version?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Skill-domain preset of `ResourceCard` (D5). Maps skill identity/provenance
 * onto the shared card anatomy; the corner unequip control is an `actions` slot
 * and source · version is the card `footer`.
 */
export function SkillCard({
  name,
  kind,
  scope,
  description,
  equipped,
  via,
  dim,
  draggable,
  onDragStart,
  onClick,
  onUnequipped,
  equipToggleTitle,
  source,
  leadingBadge,
  invocation,
  invocationControl,
  version,
  className,
  style,
}: SkillCardProps) {
  const showSourceRow = source !== undefined || version !== undefined;
  const showUnequip = onUnequipped && via !== "bundle";

  return (
    <ResourceCard
      className={`skill-card ${className ?? ""}`.trim()}
      title={name}
      style={style}
      draggable={draggable}
      onDragStart={onDragStart as React.DragEventHandler}
      onClick={onClick}
      dataset={{ equipped, via: via || undefined, dim }}
      glyph={
        <>
          {leadingBadge}
          <ScopeBadge scope={scope} />
        </>
      }
      name={name}
      meta={
        <>
          <KindTag kind={kind ?? "SKILL"} />
          <InvocationBadge invocation={invocation} />
          {invocationControl}
        </>
      }
      desc={description}
      footer={
        showSourceRow ? (
          <>
            <span>{source}</span>
            {version !== undefined && <span>v{version}</span>}
          </>
        ) : undefined
      }
      actions={
        showUnequip ? (
          <button
            type="button"
            className="equip-toggle"
            title={equipToggleTitle ?? "Unequip"}
            onClick={(e) => {
              e.stopPropagation();
              onUnequipped?.();
            }}
          >
            <Icon name="x" size={11} />
          </button>
        ) : undefined
      }
    />
  );
}
