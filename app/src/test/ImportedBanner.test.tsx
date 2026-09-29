import { it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "./helpers";
import { ImportedBanner } from "@/components/ImportedBanner";

// `ImportedBanner` has no test today; it calls
// `invoke("pick_directory", { initial: imp.backup_path })` (~:120).

const IMPORT_ROW = {
	harness_id: "claude-code",
	timestamp: "2026-09-06T12:00:00Z",
	backup_path: "/Users/dev/.claude/settings.json.bak",
	source_file: ".claude/settings.json",
};

function installRecentImports(result: unknown[] | (() => Promise<unknown[]>)) {
	vi.mocked(invoke).mockImplementation((async (cmd: string) => {
		if (cmd === "permissions_recent_imports") {
			if (typeof result === "function") return (result as () => Promise<unknown[]>)();
			return result;
		}
		if (cmd === "pick_directory") return null;
		return undefined;
	}) as never);
}

it("renders nothing when there are no recent imports", async () => {
	installRecentImports([]);
	const { container } = renderWithProviders(
		<ImportedBanner projectName="example-app" ruleCount={3} />,
	);
	await waitFor(() => expect(invoke).toHaveBeenCalledWith("permissions_recent_imports", { scope: { kind: "project", name: "example-app" } }));
	expect(container.firstChild).toBeNull();
});

it("renders nothing when the recent-imports read rejects (treated as empty)", async () => {
	installRecentImports(() => Promise.reject(new Error("boom")));
	const { container } = renderWithProviders(
		<ImportedBanner projectName="example-app" ruleCount={3} />,
	);
	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith("permissions_recent_imports", {
			scope: { kind: "project", name: "example-app" },
		}),
	);
	expect(container.firstChild).toBeNull();
});

it("shows the import banner with the rule count, harness label and source file", async () => {
	installRecentImports([IMPORT_ROW]);
	renderWithProviders(<ImportedBanner projectName="example-app" ruleCount={3} />);

	const banner = await screen.findByRole("status");
	expect(banner).toHaveTextContent("Imported 3 rules from");
	expect(banner).toHaveTextContent(".claude/settings.json");
	expect(screen.getByRole("button", { name: "view backup" })).toBeVisible();
});

it("'view backup' calls invoke(\"pick_directory\", { initial: <backup_path> })", async () => {
	installRecentImports([IMPORT_ROW]);
	renderWithProviders(<ImportedBanner projectName="example-app" ruleCount={3} />);

	fireEvent.click(await screen.findByRole("button", { name: "view backup" }));
	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith("pick_directory", {
			initial: IMPORT_ROW.backup_path,
		}),
	);
});

it("Dismiss hides the banner and persists the dismissal in localStorage", async () => {
	installRecentImports([IMPORT_ROW]);
	renderWithProviders(<ImportedBanner projectName="example-app" ruleCount={3} />);

	await screen.findByRole("status");
	fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

	await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
	expect(
		window.localStorage.getItem(
			`permissions-banner:example-app:claude-code:2026-09-06T12:00:00Z`,
		),
	).toBe("1");
});

it("a persisted dismissal from a prior session keeps the banner hidden on a fresh mount", async () => {
	window.localStorage.setItem(
		`permissions-banner:example-app:claude-code:2026-09-06T12:00:00Z`,
		"1",
	);
	installRecentImports([IMPORT_ROW]);
	const { container } = renderWithProviders(
		<ImportedBanner projectName="example-app" ruleCount={3} />,
	);

	await waitFor(() => expect(invoke).toHaveBeenCalledWith("permissions_recent_imports", { scope: { kind: "project", name: "example-app" } }));
	expect(container.querySelector('[role="status"]')).toBeNull();
});
