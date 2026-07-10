import { useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import {
	HARNESS_IDENTITY,
	harnessLabel,
} from "@/components/harness/harnessRegistry";
import { SubagentManager } from "@/components/subagents/SubagentManager";
import { useHarnesses } from "@/hooks/useHarnesses";
import type { SubagentHarness } from "@/lib/subagents";

export function HarnessConfig() {
	const { id = "" } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const harnesses = useHarnesses();

	// Capability-gated (D8): the Sub-Agents manager renders for ANY harness whose
	// schema declares agent support — not a hardwired id check. While the harness
	// list is still loading, fall back to the known-supported set so a direct
	// deep-link doesn't flash the empty state.
	const status = harnesses.find((h) => h.id === id);
	const supported =
		status?.agents?.supported ?? (id === "claude-code" || id === "codex");

	if (!supported) {
		// A known harness whose config surface simply isn't built yet reads as
		// "coming soon" (honest), not an empty dead-end. An unknown id stays generic.
		const known = id in HARNESS_IDENTITY;
		return (
			<>
				<ScreenHeader
					back={{ label: "Harnesses", onClick: () => navigate("/harnesses") }}
					title={harnessLabel(id)}
					leading={<HarnessGlyph id={id} label={harnessLabel(id)} size={20} decorative />}
				/>
				<EmptyState
					icon="cog"
					title={known ? "Configuration coming soon" : "No configuration yet"}
					description={
						known
							? `Harness-specific configuration for ${harnessLabel(id)} is on the way. Sub-agents and per-harness settings will land here in a future release.`
							: `${harnessLabel(id)} has no harness-specific configuration in Skill Tree yet.`
					}
				/>
			</>
		);
	}

	const harness = id as SubagentHarness;
	const isCodex = harness === "codex";

	// The manager owns the list ↔ editor flow. The harness chrome (header +
	// eyebrow) is passed as `listHeader` so it shows only on the list view — the
	// editor brings its own ScreenHeader and must not stack a second one.
	return (
		<SubagentManager
			harness={harness}
			initialScope="user"
			initialProject={null}
			// Codex project agents are trust-gated and ship in a later wave — the
			// scope switcher shows User only, with the Project pill disabled.
			projectScopeDisabledHint={
				isCodex
					? "Codex project agents ship later (requires project trust)."
					: undefined
			}
			listClassName="harness-config-screen"
			listHeader={
				<ScreenHeader
					back={{
						label: "Harnesses",
						onClick: () => navigate("/harnesses"),
					}}
					nameMono={harnessLabel(id)}
					leading={
						<HarnessGlyph
							id={id}
							label={harnessLabel(id)}
							size={20}
							decorative
						/>
					}
					subline={
						isCodex
							? "Sub-agents — delegatable Codex personas, edited in place"
							: "Sub-agents — focused Claude Code personas, edited in place"
					}
					crumbs={["harnesses", id]}
				/>
			}
			listLead={
				<div className="harness-config-section-eyebrow">
					<Icon name="agent" size={13} />
					<span>Sub-Agents</span>
				</div>
			}
		/>
	);
}
