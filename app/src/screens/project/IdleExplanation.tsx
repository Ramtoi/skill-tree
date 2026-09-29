import { useRef, useState, type MouseEvent } from "react";
import { IdleBadge } from "@/components/IdleBadge";
import { Popover } from "@/components/Popover";
import { MetaGrid } from "@/components/Field";
import { clickSink } from "@/lib/pressable";
import { fromNav, projectBackTarget } from "@/lib/backTarget";
import { useNavigate } from "react-router-dom";
import type { UsageFinding, UsageUtilizationRow } from "@/features/usage/usageAnalyticsTypes";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";

const BLIND_SPOT = "A skill can shape behaviour through its description alone, without ever being invoked. This counts invocations, not influence.";

export interface IdleExplanationProps {
  finding: UsageFinding;
  row: UsageUtilizationRow;
  skillKey: string;
  projectName: string;
  bundleName?: string;
  tokens: HarnessFootprintTokens | null;
  onOpenBundle?: (name: string) => void;
  canUnequip: boolean;
  canOverrideInvocation: boolean;
}

export function IdleExplanation({ finding, row, skillKey, projectName, bundleName, tokens, canUnequip, canOverrideInvocation, onOpenBundle }: IdleExplanationProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const navigate = useNavigate();
  const moves = finding.moves.filter((move) =>
    (move.kind === "unequip" && canUnequip) || (move.kind === "invocation" && canOverrideInvocation),
  );
  const visibleMoves = bundleName ? [] : moves;
  const focusMove = (kind: string) => {
    const selector = kind === "unequip" ? '[data-testid="skill-card-unequip"]' : '[data-testid="skill-card-invocation"]';
    const row = anchorRef.current?.closest<HTMLElement>(".skill-card, .project-loadout-row");
    const target = row?.querySelector<HTMLElement>(selector);
    // Row actions are displayed on focus-within. Reveal them before focusing.
    row?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    target?.focus();
    setOpen(false);
  };
  const stop = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      <span ref={anchorRef} {...clickSink()}>
        <button type="button" className="idle-explanation-trigger" aria-label="Explain idle skill" onClick={stop}>
          <IdleBadge />
        </button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label="Why this skill is idle" width={340}>
        {/* The panel is portaled, but React still bubbles its clicks through the
            component tree to the card's own onClick (which opens the skill), so
            the same click sink SkillCard uses stops them here. */}
        <div className="idle-explanation" {...clickSink()}>
          <p>{finding.observation}</p>
          <MetaGrid>
            <span>sessions</span><strong>{String(finding.numbers.sessions ?? row.sessions_with_skill)}</strong>
            {/* The finding numbers do not carry per-session tokens; skill_lines is the wave-3 static-cost workaround. */}
            <span>cost</span><strong>~{tokens?.bySkill.get(skillKey) ?? "—"} tokens every session</strong>
            <span>last used</span><strong>{row.last_used_at ?? "never"}</strong>
          </MetaGrid>
          <div className="idle-explanation-moves">
            {visibleMoves.map((move) => (
              <button key={`${move.kind}-${move.label}`} type="button" onClick={() => focusMove(move.kind)}>
                {move.label}
              </button>
            ))}
            {bundleName && (
              <p>provided by <button type="button" onClick={() => onOpenBundle ? onOpenBundle(bundleName) : navigate(`/bundle/${encodeURIComponent(bundleName)}`, fromNav(projectBackTarget(projectName)))}>{bundleName}</button></p>
            )}
            {!bundleName && visibleMoves.length === 0 && <p>No triggering control is available for this skill.</p>}
          </div>
          <p className="idle-explanation-blind-spot">{BLIND_SPOT}</p>
        </div>
      </Popover>
    </>
  );
}
