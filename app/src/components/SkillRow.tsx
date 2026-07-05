import type { MouseEvent, ReactNode } from "react";
import type { Registry, Skill } from "@/types";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { ResourceRow } from "./ResourceRow";
import { KindTag, ScopeBadge, Tag } from "./Tag";

export interface SkillRowProps {
  name: string;
  skill: Skill;
  registry: Registry;
  onClick: () => void;
  onPreview?: () => void;
  onEdit?: () => void;
  /** Opens the equip picker anchored to the triggering button's rect. */
  onOpenEquipPicker?: (anchor: DOMRect) => void;
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

/**
 * Skill-domain preset of `ResourceRow` (D5). Keeps the skill-specific
 * resolved-count / bundle-tag logic and maps it onto the shared list anatomy —
 * so skill code doesn't leak into the generic.
 */
export function SkillRow({
  name,
  skill,
  registry,
  onClick,
  onPreview,
  onEdit,
  onOpenEquipPicker,
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
    <ResourceRow
      className="skill-row"
      selected={selected}
      onClick={onClick}
      title={name}
      glyph={<ScopeBadge scope={skill.scope} />}
      name={name}
      meta={
        <>
          <KindTag kind={skill.type} />
          {source}
          {bundleTags?.map((b) => (
            <Tag color={b.color} size="sm" key={b.name}>
              {b.name}
            </Tag>
          ))}
        </>
      }
      desc={skill.description}
      actions={
        <>
          {onPreview ? (
            <Button variant="ghost" size="sm" icon="eye" title="Preview" onClick={stop(onPreview)} />
          ) : null}
          {onEdit ? (
            <Button variant="ghost" size="sm" icon="edit" title="Edit" onClick={stop(onEdit)} />
          ) : null}
          {onOpenEquipPicker ? (
            <Button
              variant="ghost"
              size="sm"
              icon="equip"
              title="Equip on…"
              onClick={(e) => {
                e.stopPropagation();
                onOpenEquipPicker(e.currentTarget.getBoundingClientRect());
              }}
            />
          ) : null}
        </>
      }
      badges={
        <>
          <span className="equipped-pip" data-active={resolvedCount > 0}>
            <Icon name="equip" size={11} />
            {resolvedCount}
          </span>
          <span className="ver">v{skill.version || "—"}</span>
        </>
      }
    />
  );
}
