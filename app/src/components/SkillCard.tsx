import type { CSSProperties, DragEvent, ReactNode } from "react";
import { Icon } from "./Icon";
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
  version?: string;
  className?: string;
  style?: CSSProperties;
}

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
  version,
  className,
  style,
}: SkillCardProps) {
  const showSourceRow = source !== undefined || version !== undefined;
  const showUnequip = onUnequipped && via !== "bundle";

  return (
    <div
      className={`skill-card ${className ?? ""}`.trim()}
      data-equipped={equipped || undefined}
      data-via={via || undefined}
      data-dim={dim || undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      style={style}
    >
      <div className="row1">
        {leadingBadge}
        <ScopeBadge scope={scope} />
        <span className="name">{name}</span>
        <KindTag kind={kind ?? "SKILL"} />
      </div>
      {description && <div className="desc">{description}</div>}
      {showSourceRow && (
        <div className="source-row">
          <span>{source}</span>
          {version !== undefined && <span>v{version}</span>}
        </div>
      )}
      {showUnequip && (
        <button
          type="button"
          className="equip-toggle"
          title={equipToggleTitle ?? "Unequip"}
          onClick={(e) => {
            e.stopPropagation();
            onUnequipped();
          }}
        >
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  );
}
