import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Route, Routes } from "react-router-dom";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { queryClient } from "@/lib/queryClient";
import { useAppStore } from "@/store";
import { primeRegistry, renderWithProviders } from "./helpers";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

const NEW_CANDIDATE = {
	name: "local-helper",
	project: "example-app",
	path: "/Users/dev/example-app/.claude/skills/local-helper",
	rel: ".claude/skills/local-helper",
	category: "NEW",
	version: "0.1.0",
	description: "A hand-authored helper waiting to be adopted.",
};

const INVALID_CANDIDATE = {
	name: "Bad Name!",
	project: "example-app",
	path: "/Users/dev/example-app/.claude/skills/Bad Name!",
	rel: ".claude/skills/Bad Name!",
	category: "INVALID_NAME",
	version: null,
	description: "",
	reason: "Folder name is not a valid skill slug.",
};

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
});

describe("ProjectWorkspace — detected local skills", () => {
	it("renders a NEW candidate and adopts it on click", async () => {
		const calls: string[][] = [];
		vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
			if (cmd === "project_scan_candidates") return [NEW_CANDIDATE];
			if (cmd === "path_exists") return false;
			if (cmd === "harness_list") return [];
			if (cmd === "hub_cmd") {
				const args = (payload as { args: string[] }).args;
				calls.push(args);
				return { success: true, output: "" };
			}
			return undefined;
		});
		renderWorkspace();

		// Section + candidate render.
		await screen.findByText("Detected local skills");
		expect(screen.getByText("local-helper")).toBeInTheDocument();
		expect(
			screen.getByText("A hand-authored helper waiting to be adopted."),
		).toBeInTheDocument();

		const adopt = screen.getByRole("button", { name: "Adopt" });
		fireEvent.click(adopt);

		await waitFor(() => {
			expect(
				calls.some(
					(a) =>
						a[0] === "project" &&
						a[1] === "import-skill" &&
						a[2] === "local-helper" &&
						a[3] === "--project" &&
						a[4] === "example-app",
				),
			).toBe(true);
		});

		// Adoption triggers a candidate refetch (second scan call).
		await waitFor(() => {
			const scanCalls = vi
				.mocked(invoke)
				.mock.calls.filter((c) => c[0] === "project_scan_candidates");
			expect(scanCalls.length).toBeGreaterThanOrEqual(2);
		});
	});

	it("renders an INVALID_NAME candidate read-only with its reason and no Adopt", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === "project_scan_candidates") return [INVALID_CANDIDATE];
			if (cmd === "path_exists") return false;
			if (cmd === "harness_list") return [];
			return undefined;
		});
		renderWorkspace();

		await screen.findByText("Detected local skills");
		expect(
			screen.getByText("Folder name is not a valid skill slug."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Adopt" })).toBeNull();
	});

	it("omits the section entirely when there are no candidates", async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === "project_scan_candidates") return [];
			if (cmd === "path_exists") return false;
			if (cmd === "harness_list") return [];
			return undefined;
		});
		renderWorkspace();

		await screen.findByText("Equipped skills");
		expect(screen.queryByText("Detected local skills")).toBeNull();
	});
});
