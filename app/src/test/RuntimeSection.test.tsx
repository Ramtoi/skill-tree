import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { renderWithProviders, sampleRegistry, makeQueryClient } from "./helpers";
import { RuntimeSection } from "@/components/skillEditor/RuntimeSection";

function renderRuntime(
	over: Partial<React.ComponentProps<typeof RuntimeSection>> = {},
) {
	const onAffinityChange = vi.fn();
	renderWithProviders(
		<RuntimeSection
			skill={sampleRegistry.skills.brainstorm}
			installedHarnesses={["claude-code", "codex"]}
			affinity={[]}
			onAffinityChange={onAffinityChange}
			onInvocationPick={() => {}}
			invocationBusy={false}
			readOnly={false}
			storageKey="st:test:runtime"
			{...over}
		/>,
		{ client: makeQueryClient() },
	);
	return { onAffinityChange };
}

describe("RuntimeSection", () => {
	it("ships collapsed and states mode + harness reach in the head", () => {
		renderRuntime();
		const head = screen.getByTestId("side-section-runtime");
		expect(head).toHaveAttribute("aria-expanded", "false");
		const section = document.querySelector("[data-section-id='runtime']")!;
		expect(section.textContent).toContain("Auto");
		expect(section.textContent).toContain("all harnesses");
		expect(screen.queryByRole("radiogroup", { name: "Triggering" })).toBeNull();
	});

	it("narrows affinity to a subset when a harness chip is toggled off", () => {
		const { onAffinityChange } = renderRuntime({ affinity: [] });
		fireEvent.click(screen.getByTestId("side-section-runtime"));
		// affinity [] = all → both chips applied; clicking Codex narrows to claude-code.
		fireEvent.click(within(screen.getByRole("group", { name: "Harness affinity" })).getByRole("button", { name: /Codex/ }));
		expect(onAffinityChange).toHaveBeenCalledWith(["claude-code"]);
	});

	it("clears affinity to [] (all effective) when the last harness is toggled off", () => {
		const { onAffinityChange } = renderRuntime({ affinity: ["claude-code"] });
		fireEvent.click(screen.getByTestId("side-section-runtime"));
		fireEvent.click(within(screen.getByRole("group", { name: "Harness affinity" })).getByRole("button", { name: /Claude Code/ }));
		expect(onAffinityChange).toHaveBeenCalledWith([]);
	});

	it("read-only: a harness chip is a real disabled button and never calls onAffinityChange", () => {
		const { onAffinityChange } = renderRuntime({ readOnly: true });
		fireEvent.click(screen.getByTestId("side-section-runtime"));
		const chip = within(screen.getByRole("group", { name: "Harness affinity" })).getByRole("button", { name: /Codex/ });
		expect(chip).toBeDisabled();
		fireEvent.click(chip);
		expect(onAffinityChange).not.toHaveBeenCalled();
		// Locked = every trigger radio disabled too, with the reason.
		expect(screen.getByRole("radio", { name: /User-only/ })).toBeDisabled();
	});
});
