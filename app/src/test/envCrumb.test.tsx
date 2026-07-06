import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";
import { primeRegistry, renderWithProviders } from "./helpers";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

const ENV_PATH = "/Users/dev/example-app/.env";

// The create→open flip relies on `createEnvFile` invalidating the env-exists
// query through the app-global queryClient, so these tests render with that
// client instead of a per-test one.
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
	primeRegistry(queryClient);
	renderWithProviders(
		<Routes>
			<Route path="/project/:name" element={<ProjectWorkspace />} />
		</Routes>,
		{ client: queryClient, initialRoute: "/project/example-app" },
	);
}

beforeEach(() => {
	queryClient.clear();
	vi.mocked(openPath).mockClear();
});

describe("ProjectWorkspace .env crumb", () => {
	it("shows an open chip when .env exists and opens it with the default app", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === "path_exists") return true;
			if (cmd === "harness_list") return [];
			return undefined;
		});
		renderWorkspace();

		const chip = await screen.findByTitle("Open .env in default app");
		fireEvent.click(chip);

		expect(openPath).toHaveBeenCalledWith(ENV_PATH);
		expect(invoke).toHaveBeenCalledWith("path_exists", { path: ENV_PATH });
	});

	it("shows a create chip when .env is missing, creates an empty file, and flips to open", async () => {
		let envExists = false;
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd === "path_exists") return envExists;
			if (cmd === "create_empty_file") {
				expect(payload).toEqual({ path: ENV_PATH });
				envExists = true;
				return undefined;
			}
			if (cmd === "harness_list") return [];
			return undefined;
		});
		renderWorkspace();

		const add = await screen.findByTitle("Create empty .env");
		fireEvent.click(add);

		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("create_empty_file", {
				path: ENV_PATH,
			});
		});
		// Invalidation refetches path_exists (now true) → chip flips to open.
		await screen.findByTitle("Open .env in default app");
		expect(screen.queryByTitle("Create empty .env")).toBeNull();
		expect(openPath).not.toHaveBeenCalled();
	});

	it("renders no env chip while the existence check is unresolved", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === "path_exists") return new Promise<never>(() => {});
			if (cmd === "harness_list") return [];
			return undefined;
		});
		renderWorkspace();

		await screen.findByText("Loadout");
		expect(screen.queryByTitle("Open .env in default app")).toBeNull();
		expect(screen.queryByTitle("Create empty .env")).toBeNull();
	});
});
