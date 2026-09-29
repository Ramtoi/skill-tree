import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, primeRegistry, makeQueryClient } from "./helpers";
import { SkillLibrary } from "@/screens/SkillLibrary";

// A8: the Library's SkillRow/SkillCard callers gate the source chip to
// external sources only (R1) and pass bundle membership via `bundleNames`.

describe("Library list — source chip is an external-only deviation", () => {
	it("a local-source skill renders no .source-chip; the external one does", () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<SkillLibrary />, { client });

		const localRow = screen.getByText("brainstorm").closest(".resource-row")!;
		expect(localRow.querySelector(".source-chip")).toBeNull();

		const extRow = screen
			.getByText("android-compose-ui")
			.closest(".resource-row")!;
		fireEvent.click(extRow.querySelector(".resource-disclosure")!);
		expect(extRow.querySelector(".source-chip")).not.toBeNull();
	});
});

describe("Library grid — equipped-pip badges", () => {
	it("each SkillCard carries an .equipped-pip whose count matches equippedCounts", () => {
		const client = makeQueryClient();
		primeRegistry(client);
		renderWithProviders(<SkillLibrary />, { client });

		fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

		// example-app applies the "android" bundle (rt-android-expert,
		// android-compose-ui) and directly enables brainstorm — all three
		// resolve to an equipped count of 1. fs-mcp is unequipped anywhere.
		const brainstormCard = screen
			.getByText("brainstorm")
			.closest(".resource-card")!;
		const brainstormPip = brainstormCard.querySelector(".equipped-pip")!;
		expect(brainstormPip).not.toBeNull();
		expect(brainstormPip.textContent).toContain("1");
		expect(brainstormPip.getAttribute("data-active")).toBe("true");

		const mcpCard = screen.getByText("fs-mcp").closest(".resource-card")!;
		const mcpPip = mcpCard.querySelector(".equipped-pip")!;
		expect(mcpPip).not.toBeNull();
		expect(mcpPip.textContent).toContain("0");
		expect(mcpPip.getAttribute("data-active")).toBe("false");
	});
});
