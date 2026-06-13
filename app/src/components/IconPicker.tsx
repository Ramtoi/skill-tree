/**
 * Emoji icon picker: a quick-pick grid of common choices plus a custom
 * free-text field, so any emoji is still reachable. Controlled — owns no
 * state. Mirrors the inline picker pattern from PresetsSheet.
 */

export const DEFAULT_ICON_CHOICES = [
  "📦",
  "🔧",
  "⚡",
  "🌿",
  "🤖",
  "🛠️",
  "🧪",
  "📜",
  "🔒",
  "🌐",
  "✨",
  "📁",
];

interface IconPickerProps {
  value: string;
  onChange: (icon: string) => void;
  choices?: string[];
}

export function IconPicker({
  value,
  onChange,
  choices = DEFAULT_ICON_CHOICES,
}: IconPickerProps) {
  return (
    <div className="icon-picker">
      <div className="icon-picker-grid" role="group" aria-label="Icon choices">
        {choices.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`icon-picker-option${value === opt ? " is-active" : ""}`}
            aria-pressed={value === opt}
            aria-label={`Use ${opt}`}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      <input
        className="icon-picker-custom"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="📦"
        aria-label="Custom icon"
      />
    </div>
  );
}
