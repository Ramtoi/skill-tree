import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { ProjectUsageTab } from "@/screens/project/ProjectUsageTab";
import { renderWithProviders } from "./helpers";

function StateProbe() {
	const location = useLocation();
	return <output data-testid="history-state">{JSON.stringify(location.state ?? null)}</output>;
}

describe("ProjectUsageTab", () => {
	it("renders the project chrome, folded navigator, and one window selector", async () => {
		renderWithProviders(
			<ProjectUsageTab
				projectName="example-app"
				navigator={<nav aria-label="Project areas" data-expanded="false" />}
			/>,
		);
		await screen.findByText("usage never scanned");
		expect(screen.getByRole("button", { name: "Scan" })).toBeInTheDocument();
		expect(screen.getAllByRole("radiogroup", { name: "Window" })).toHaveLength(1);
		expect(document.querySelector(".project-usage-body.screen-pad.main-body")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("navigation", { name: "Project areas" })).toBeInTheDocument());
	});

	it("hands an allowed usage window from navigation state to the project host", async () => {
		localStorage.removeItem("st:usage:window");
		renderWithProviders(
			<><ProjectUsageTab projectName="example-app" navigator={<nav aria-label="Project areas" />} /><StateProbe /></>,
			{ initialRoute: { pathname: "/project/example-app", state: { usageWindow: 7 } } },
		);
		expect(await screen.findByRole("radio", { name: "7 days" })).toBeChecked();
		expect(localStorage.getItem("st:usage:window")).toBe("7");
		await waitFor(() => expect(screen.getByTestId("history-state")).toHaveTextContent("{}"));
	});
});
