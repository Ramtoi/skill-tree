import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ScanButton } from "@/screens/usage/UsageScanAction";
import { useUsageWindow } from "@/screens/usage/useUsageWindow";
import { UsageProjectArea } from "@/screens/usage/UsageProjectArea";
import { useUsageProject } from "@/hooks/useUsageAnalytics";
import { usageAsOfLine } from "@/lib/usageProjectInsights";
import { fromNav, projectAreaBackTarget } from "@/lib/backTarget";
import { useUsageLoadoutDelta } from "@/store/usageLoadoutDelta";

interface Props {
	projectName: string;
	navigator: ReactNode;
}

export function ProjectUsageTab({ projectName, navigator }: Props) {
	const navigate = useNavigate();
 const location = useLocation();
	const { window, setWindow } = useUsageWindow();
	const project = useUsageProject(projectName, window);
	const delta = useUsageLoadoutDelta(projectName);
	return (
		<>
			<ScreenHeader
				leading={<span className="project-dot" />}
				nameMono={projectName}
				crumbs={["project", projectName, "usage"]}
				subline={usageAsOfLine(project.data?.last_scan_at ?? null)}
				primary={<ScanButton />}
			/>
			{navigator}
			{/* Keyboard focus is required because this region owns the page scroll. */}
			{/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
			<div className="main-body screen-pad project-usage-body" role="region" tabIndex={0} aria-label="Project usage content">
				{delta && delta.delta !== 0 && (
					<div className="usage-loadout-delta" role="status">
						{delta.delta > 0 ? "+" : "−"}{Math.abs(delta.delta).toLocaleString()} tokens since last loadout change
					</div>
				)}
				<UsageProjectArea
					name={projectName}
					window={window}
					onWindowChange={setWindow}
					onOpenSession={(sessionId, harness) =>
						navigate(
							`/usage/session/${encodeURIComponent(sessionId)}?harness=${encodeURIComponent(harness)}`,
							fromNav({ ...projectAreaBackTarget(projectName, "usage"), path: location.pathname + location.search, restore: { ...location.state, usageWindow: window } }),
						)
					}
				/>
			</div>
		</>
	);
}
