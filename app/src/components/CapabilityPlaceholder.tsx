import { Icon } from "./Icon";
import { HarnessIconGroup } from "./harness/HarnessGlyph";

export interface CapabilityPlaceholderProps {
  /** Human-readable labels of harnesses that don't support the feature. */
  unsupportedLabels: string[];
  unsupportedIds?: string[];
  labels?: Record<string, string>;
  /** Optional feature noun for the leading prose ("hooks", "approval policy", …). */
  feature?: string;
}

/** Dimmed informational block ("Not supported by <labels>") rendered when an
 *  entire subsection's feature is missing from every installed harness. */
export function CapabilityPlaceholder({
  unsupportedLabels,
  unsupportedIds,
  labels,
  feature,
}: CapabilityPlaceholderProps) {
  const list =
    unsupportedLabels.length === 0
      ? "the installed harnesses"
      : unsupportedLabels.join(", ");
  return (
    <div
      className="capability-placeholder"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderRadius: "var(--radius)",
        border: "1px dashed color-mix(in oklab, var(--cyan) 40%, transparent)",
        background: "color-mix(in oklab, var(--cyan) 6%, transparent)",
        color: "var(--cyan)",
        fontSize: 12,
        fontFamily: "var(--font-sans)",
      }}
    >
      <Icon name="warning" size={13} />
      <span>
        Not supported by{" "}
        {unsupportedIds && unsupportedIds.length > 0 && (
          <>
            <HarnessIconGroup ids={unsupportedIds} labels={labels} size={14} />{" "}
          </>
        )}
        <span style={{ fontFamily: "var(--font-mono)" }}>{list}</span>
        {feature ? <> — {feature} unavailable</> : null}
      </span>
    </div>
  );
}
