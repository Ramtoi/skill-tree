import { Icon } from "@/components/Icon";

/** Shell-level Settings opener. It remains mounted when both navigation
 * surfaces are hidden so users can always recover the configuration dialog. */
export function SettingsToggle({ onClick, visible = true }: { onClick: () => void; visible?: boolean }) {
  return (
    <button
      type="button"
      className="settings-toggle"
      title="Settings"
      aria-label="Settings"
      data-hidden={!visible || undefined}
      onClick={onClick}
    >
      <Icon name="cog" size={14} />
    </button>
  );
}
