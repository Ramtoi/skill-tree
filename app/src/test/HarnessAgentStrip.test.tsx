import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HarnessAgentStrip } from "@/components/harness/HarnessAgentStrip";
import { useAppStore, type HarnessStatus } from "@/store";
import { renderWithProviders } from "./helpers";

const CODEX: HarnessStatus = {
	id: "codex",
	label: "Codex",
	installed: true,
	on_globally: false,
	used_by_projects: ["moon-base"],
	version: "0.142.2",
};

const baseProps = {
	projectName: "moon-base",
	projectPath: "/Users/dev/projects/moon-base",
	globalHarnesses: [] as string[],
	projectHarnesses: ["codex"],
	policy: null,
	allCanonical: false,
};

beforeEach(() => {
	useAppStore.setState({ harnesses: [CODEX], mutating: false });
	vi.mocked(invoke).mockClear();
});

describe("HarnessAgentStrip", () => {
	it("keeps the dialog mounted and restores focus when the effective list becomes empty", async () => {
		const user = userEvent.setup();
		const { rerender } = renderWithProviders(
			<HarnessAgentStrip
				{...baseProps}
				effectiveHarnesses={[{ id: "codex", label: "Codex" }]}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Manage" });
		await user.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "Harnesses for moon-base",
		});
		await waitFor(() =>
			expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus(),
		);

		rerender(<HarnessAgentStrip {...baseProps} effectiveHarnesses={[]} />);
		expect(screen.getByRole("dialog", { name: "Harnesses for moon-base" })).toBe(dialog);

		await user.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("loads manager data only after the dialog opens", async () => {
		const user = userEvent.setup();
		renderWithProviders(
			<HarnessAgentStrip
				{...baseProps}
				effectiveHarnesses={[{ id: "codex", label: "Codex" }]}
			/>,
		);

		expect(invoke).not.toHaveBeenCalledWith("agent_docs_strategy_get", expect.anything());
		await user.click(screen.getByRole("button", { name: "Manage" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("agent_docs_strategy_get", {
				projectName: "moon-base",
			}),
		);
	});
});
