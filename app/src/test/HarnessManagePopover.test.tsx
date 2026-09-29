import { it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders } from "./helpers";
import { HarnessManagePopover } from "@/components/harness/HarnessManagePopover";
import { useAppStore, type HarnessStatus } from "@/store";

// `HarnessManagePopover` has no test today; it calls
// `invoke("project_set_harnesses", …)` (~:140) to persist a toggle.

const CLAUDE_CODE: HarnessStatus = {
	id: "claude-code",
	label: "Claude Code",
	installed: true,
	on_globally: false,
	used_by_projects: [],
	path: "/usr/bin/claude",
	version: "1.0",
};

beforeEach(() => {
	// `useHarnesses()` reads the store directly and only rescans when empty —
	// seed it so the popover renders a stable, known row without a mocked
	// `harness_list` round trip.
	useAppStore.setState({ harnesses: [CLAUDE_CODE] });
});

function renderPopover(opts: { projectHarnesses?: string[] } = {}) {
	return renderWithProviders(
		<HarnessManagePopover
			open
			projectName="example-app"
			projectPath="/Users/dev/example-app"
			globalHarnesses={[]}
			projectHarnesses={opts.projectHarnesses ?? []}
			onClose={() => {}}
		/>,
	);
}

function claudeRow() {
	return screen.getByText("Claude Code").closest("button")!;
}

/** Installs a `project_set_harnesses` handler while chaining every other
 *  command to setup.ts's default mock (the strategy/publish queries this
 *  popover always renders need their default answers). */
function installProjectSetHarnesses(handler: () => unknown) {
	const mock = vi.mocked(invoke);
	const prev = mock.getMockImplementation();
	mock.mockImplementation(((cmd: string, args?: unknown) =>
		cmd === "project_set_harnesses"
			? Promise.resolve().then(handler)
			: (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
}

it("toggling ON sends `project_set_harnesses` with the project and the next harness list, and a success clears the busy state without a failure toast", async () => {
	installProjectSetHarnesses(() => undefined);
	renderPopover({ projectHarnesses: [] });

	fireEvent.click(claudeRow());

	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith("project_set_harnesses", {
			project: "example-app",
			harnesses: ["claude-code"],
		}),
	);
	await waitFor(() => expect(claudeRow()).not.toHaveAttribute("aria-busy"));
	expect(
		useAppStore.getState().toasts.some((t) => t.title === "Couldn't update harnesses"),
	).toBe(false);
});

it("toggling OFF sends the harness list with that id removed", async () => {
	installProjectSetHarnesses(() => undefined);
	renderPopover({ projectHarnesses: ["claude-code"] });

	fireEvent.click(claudeRow());

	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith("project_set_harnesses", {
			project: "example-app",
			harnesses: [],
		}),
	);
});

it("a failed write shows the failure toast and clears the busy state", async () => {
	installProjectSetHarnesses(() => {
		throw new Error("disk full");
	});
	renderPopover({ projectHarnesses: [] });

	fireEvent.click(claudeRow());

	await waitFor(() =>
		expect(
			useAppStore.getState().toasts.some(
				(t) => t.title === "Couldn't update harnesses" && t.body === "Error: disk full",
			),
		).toBe(true),
	);
	await waitFor(() => expect(claudeRow()).not.toHaveAttribute("aria-busy"));
	expect(claudeRow()).not.toBeDisabled();
});
