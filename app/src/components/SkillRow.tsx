import type { MouseEvent, ReactNode } from "react";
import type { Registry, Skill } from "@/types";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { KindTag, ScopeBadge, Tag } from "./Tag";

export interface SkillRowProps {
  name: string;
  skill: Skill;
  registry: Registry;
  onClick: () => void;
  onPreview?: () => void;
  onEdit?: () => void;
  onEquipOn?: () => void;
  equippedCount?: number;
  bundleTags?: Array<{ name: string; color: string }>;
  selected?: boolean;
  /** Optional source chip rendered alongside the kind/bundle tags. */
  source?: ReactNode;
}

function stop(fn: () => void) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    fn();
  };
}

export function SkillRow({
  name,
  skill,
  registry,
  onClick,
  onPreview,
  onEdit,
  onEquipOn,
  equippedCount,
  bundleTags,
  selected,
  source,
}: SkillRowProps) {
  const resolvedCount =
    equippedCount ??
    Object.values(registry.projects).filter((p) =>
      resolveActiveSkills(p, registry).includes(name),
    ).length;

  return (
    <button
      type="button"
      className="skill-row"
      data-selected={selected || undefined}
      onClick={onClick}
    >
      <ScopeBadge scope={skill.scope} />
      <div className="name-cell">
        <span className="name">{name}</span>
        <KindTag kind={skill.type} />
        {source}
        {bundleTags?.map((b) => (
          <Tag color={b.color} size="sm" key={b.name}>
            {b.name}
          </Tag>
        ))}
        <span className="desc">{skill.description}</span>
      </div>
      <div className="row-actions">
        {onPreview ? (
          <Button
            variant="ghost"
            size="sm"
            icon="eye"
            title="Preview"
            onClick={stop(onPreview)}
          />
        ) : null}
        {onEdit ? (
          <Button
            variant="ghost"
            size="sm"
            icon="edit"
            title="Edit"
            onClick={stop(onEdit)}
          />
        ) : null}
        {onEquipOn ? (
          <Button
            variant="ghost"
            size="sm"
            icon="equip"
            title="Equip on…"
            onClick={stop(onEquipOn)}
          />
        ) : null}
      </div>
      <span className="equipped-pip" data-active={resolvedCount > 0}>
        <Icon name="equip" size={11} />
        {resolvedCount}
      </span>
      <span className="ver">v{skill.version || "—"}</span>
    </button>
  );
}
