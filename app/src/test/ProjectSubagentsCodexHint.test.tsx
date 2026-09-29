import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";
import type { Registry } from "@/types";

// Surfaces the current path so we can assert the routing affordance actually
// navigates to where Codex user-scope agents live (/harness/codex).
function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

function renderSubagentsTab(registry: Registry) {
	useAppStore.setState({
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
			{
				id: "codex",
				label: "Codex",
				installed: true,
				on_globally: false,
				used_by_projects: [],
			},
		],
	});
	const client = makeQueryClient();
	primeRegistry(client, registry);
	return renderWithProviders(
		<>
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
				<Route path="/harness/:id" element={<div>HARNESS PAGE</div>} />
			</Routes>
			<LocationProbe />
		</>,
		{ client, initialRoute: "/project/example-app?tab=subagents" },
	);
}

describe("ProjectWorkspace Sub-Agents · Codex scope clarity", () => {
	it("explains that Codex agents are user-wide and routes to the harness surface when codex is active", async () => {
		const reg = structuredClone(sampleRegistry);
		reg.harnesses_global = ["claude-code", "codex"];
		renderSubagentsTab(reg);

		await waitFor(() => {
			expect(
				screen.getByText(/user-wide by design/i),
			).toBeInTheDocument();
		});

		fireEvent.click(
			screen.getByRole("button", { name: /Manage Codex agents/i }),
		);

		await waitFor(() => {
			expect(screen.getByText("HARNESS PAGE")).toBeInTheDocument();
		});
		expect(screen.getByTestId("loc")).toHaveTextContent("/harness/codex");
	});

	it("honours codex added at project scope (not just global)", async () => {
		const reg = structuredClone(sampleRegistry);
		reg.projects["example-app"].harnesses = ["codex"];
		renderSubagentsTab(reg);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Manage Codex agents/i }),
			).toBeInTheDocument();
		});
	});

	it("omits the Codex hint when codex is not an effective harness", async () => {
		// sampleRegistry has no harnesses_global and the project declares none,
		// so codex is not active — the hint would be noise here.
		renderSubagentsTab(structuredClone(sampleRegistry));

		await waitFor(() => {
			expect(screen.getByText(/Project sub-agents/i)).toBeInTheDocument();
		});
		expect(screen.queryByText(/user-wide by design/i)).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Manage Codex agents/i }),
		).toBeNull();
	});
});
