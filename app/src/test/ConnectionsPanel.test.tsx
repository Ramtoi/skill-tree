import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";

function renderPanel(
	over: Partial<React.ComponentProps<typeof ConnectionsPanel>> = {},
) {
	const onAffinityChange = vi.fn();
	renderWithProviders(
		<ConnectionsPanel
			skillName="brainstorm"
			registry={sampleRegistry}
			installedHarnesses={["claude-code", "codex"]}
			affinity={[]}
			onAffinityChange={onAffinityChange}
			{...over}
		/>,
		{ client: makeQueryClient() },
	);
	return { onAffinityChange };
}

describe("ConnectionsPanel", () => {
	it("is glanceable: sections render with counts; projects disclosed by default", () => {
		renderPanel();
		expect(screen.getByText("Projects")).toBeInTheDocument();
		expect(screen.getByText("Bundles")).toBeInTheDocument();
		expect(screen.getByText("Harness targets")).toBeInTheDocument();
		expect(screen.getByText("Sub-agents")).toBeInTheDocument();
		// Projects section is open → its equip picker (search) is visible.
		expect(screen.getByPlaceholderText("Filter projects…")).toBeInTheDocument();
		// Bundles collapsed → its picker not mounted yet.
		expect(screen.queryByPlaceholderText("Add to bundle…")).toBeNull();
	});

	it("discloses the bundles picker on expand", () => {
		renderPanel();
		fireEvent.click(screen.getByText("Bundles"));
		expect(screen.getByPlaceholderText("Add to bundle…")).toBeInTheDocument();
	});

	it("narrows affinity to a subset when a harness chip is toggled off", () => {
		const { onAffinityChange } = renderPanel({ affinity: [] });
		fireEvent.click(screen.getByText("Harness targets"));
		// affinity [] = all → both chips active; clicking Codex narrows to claude-code.
		fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
		expect(onAffinityChange).toHaveBeenCalledWith(["claude-code"]);
	});

	it("clears affinity to [] (all effective) when the last harness is toggled off", () => {
		const { onAffinityChange } = renderPanel({ affinity: ["claude-code"] });
		fireEvent.click(screen.getByText("Harness targets"));
		fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
		expect(onAffinityChange).toHaveBeenCalledWith([]);
	});
});
