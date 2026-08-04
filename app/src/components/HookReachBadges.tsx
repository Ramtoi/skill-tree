import { StatusBadge } from "@/components/StatusBadge";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import type { HookCapabilitiesCache } from "@/hooks/useHooks";
import { reachBadges } from "@/lib/hookReach";

interface HookReachBadgesProps {
	capabilities: HookCapabilitiesCache | null | undefined;
	/** When set (editor event picker), downgrade harnesses that don't support the
	 *  selected event to a neutral "event unsupported" badge. */
	event?: string;
	className?: string;
}

/**
 * Per-harness reach badges from the probe capability cache (D7). Green = the hook
 * will fire here (`supported`); neutral = it won't (feature_off / unsupported /
 * event-unsupported), with the verdict's reason in a tooltip. `not_installed`
 * harnesses are omitted. Shared by the library rows and the editor event picker.
 */
export function HookReachBadges({
	capabilities,
	event,
	className,
}: HookReachBadgesProps) {
	const badges = reachBadges(capabilities, event);
	if (badges.length === 0) {
		return (
			<span className="hook-reach-empty text-dim" title="Run `hub sync` to probe hook capability per harness.">
				reach unknown
			</span>
		);
	}
	return (
		<span className={`hook-reach${className ? ` ${className}` : ""}`}>
			{badges.map((b) => (
				<StatusBadge
					key={b.harnessId}
					channel={b.tone === "ok" ? "ok" : "neutral"}
					shape="dot"
					title={b.reason || undefined}
					className="hook-reach-badge"
					ariaLabel={`${harnessLabel(b.harnessId)}: ${
						b.tone === "ok" ? "supported" : b.eventUnsupported ? "event unsupported" : b.verdict
					}`}
				>
					<span className="text-mono">{harnessLabel(b.harnessId)}</span>
				</StatusBadge>
			))}
		</span>
	);
}
