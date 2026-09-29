import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes, useLocation } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { useAppStore } from "@/store";
import {
	makeQueryClient,
	primeRegistry,
	renderWithProviders,
	sampleRegistry,
} from "./helpers";

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{loc.pathname}</div>;
}

function renderWorkspace() {
	useAppStore.setState({
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				installed: true,
				on_globally: true,
				used_by_projects: [],
			},
		],
	});
	const client = makeQueryClient();
	primeRegistry(client, sampleRegistry);
	renderWithProviders(
		<>
			<LocationProbe />
			<Routes>
				<Route path="/project/:name" element={<ProjectWorkspace />} />
			</Routes>
		</>,
		{ client, initialRoute: "/project/example-app" },
	);
}

describe("project header — rename in place", () => {
	it("renames through `hub project rename` and follows the new route", async () => {
		renderWorkspace();

		await userEvent.click(
			screen.getByRole("button", { name: "Rename project name: example-app" }),
		);
		const field = screen.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(field);
		await userEvent.type(field, "example-two");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({
					args: ["project", "rename", "example-app", "example-two"],
				}),
			),
		);
		await waitFor(() =>
			expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-two"),
		);
		expect(
			useAppStore.getState().toasts.find((t) => t.title === "Renamed example-app to example-two"),
		).toBeDefined();
	});

	it("refuses a name another project already holds", async () => {
		renderWorkspace();

		await userEvent.click(screen.getByRole("button", { name: /rename project name/i }));
		const field = screen.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(field);
		await userEvent.type(field, "example-app");
		// Same as the current name: nothing to save.
		expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

		await userEvent.type(field, "!");
		expect(field).toHaveAttribute("aria-invalid", "true");
		await userEvent.keyboard("{Enter}");
		expect(invoke).not.toHaveBeenCalledWith(
			"hub_cmd",
			expect.objectContaining({ args: expect.arrayContaining(["rename"]) }),
		);
	});

	it("surfaces a failed rename and keeps the field open", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			const args = (payload as { args?: string[] } | undefined)?.args ?? [];
			if (cmd === "hub_cmd" && args[1] === "rename") {
				return { success: false, output: "Error: State file already exists" };
			}
			if (cmd === "hub_cmd") return { success: true, output: "" };
			if (cmd === "check_python") return true;
			return undefined;
		});
		renderWorkspace();

		await userEvent.click(screen.getByRole("button", { name: /rename project name/i }));
		await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "-x");
		await userEvent.keyboard("{Enter}");

		await waitFor(() =>
			expect(
				useAppStore.getState().toasts.find((t) => t.title === "Couldn't rename project"),
			).toBeDefined(),
		);
		expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
			"example-app-x",
		);
		expect(screen.getByTestId("loc")).toHaveTextContent("/project/example-app");
	});

	it("opens the Edit path dialog from the path crumb", async () => {
		renderWorkspace();

		await userEvent.click(
			screen.getByRole("button", { name: "Edit project path: /Users/dev/example-app" }),
		);
		expect(
			await screen.findByRole("dialog", { name: "Edit path for example-app" }),
		).toBeInTheDocument();
	});
});
